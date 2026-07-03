import ExpoModulesCore
import AVFoundation

/**
 * GrokAudioModule — bidirectional PCM16 streaming for the xAI Realtime Voice Agent.
 *
 * Capture: AVAudioEngine input tap → 24kHz / mono / Int16 PCM → emitted as base64
 *          chunks via `onAudioData` (one ~20ms frame per event).
 *
 * Playback: PCM16 chunks arriving from the WebSocket are scheduled on an
 *          AVAudioPlayerNode through a converter (client format → node format)
 *          so Grok's spoken responses play continuously with low latency.
 *
 * Audio session: `.playAndRecord` + `.allowBluetooth`/`.allowBluetoothA2DP`/`.allowAirPlay`,
 *          mode `.voiceChat` — identical routing to the rest of the app so sound
 *          keeps going out through the AiMB-S1 glasses' HFP speakers.
 *
 * NOTE: In Grok mode there is no STT↔TTS handoff (the session is continuously
 * playAndRecord), which is simpler than the pipeline mode. The Bluetooth options
 * are preserved so the glasses remain the audio route.
 */
public class GrokAudioModule: Module {
  private let engine = AVAudioEngine()
  private let playerNode = AVAudioPlayerNode()
  private var converter: AVAudioConverter?
  private var playerMixer: AVAudioMixerNode?

  // Target format shared by capture + playback: PCM Int16, 24kHz, mono.
  private let pcm16Format: AVAudioFormat = AVAudioFormat(
    commonFormat: .pcmFormatInt16,
    sampleRate: 24000,
    channels: 1,
    interleaved: true
  )!

  private var isCapturing = false
  private var isSessionActive = false
  private var isPlaying = false

  // Ring-buffer-ish accounting for player scheduling (avoid underflow noise).
  private let playerQueue = DispatchQueue(label: "smartglasses.grok.player")
  private var scheduledFrames: Int = 0
  private let maxScheduledFrames = 24000 * 2 // ~2s of audio buffered at most

  public func definition() -> ModuleDefinition {
    Name("GrokAudio")

    Events("onAudioData", "onStateChange", "onError", "onPlaybackFinished")

    // ── Session lifecycle ────────────────────────────────────
    Function("startSession") { () -> Bool in
      self.configureAudioSession()
      self.startEnginePlayback()
      self.isSessionActive = true
      self.emitState("ready")
      return true
    }

    Function("stopSession") { () -> Void in
      self.stopCapture()
      self.stopPlayback()
      if self.engine.isRunning {
        self.engine.stop()
      }
      self.deactivateAudioSession()
      self.isSessionActive = false
      self.emitState("stopped")
    }

    // ── Playback-only session (for the cheap pipeline path) ──
    // A lighter lifecycle that only sets up the player (no mic tap). Used by
    // the Kokoro streaming TTS path so response audio plays through the glasses
    // with the same low-latency ring buffer as the realtime path.
    Function("startPlaybackSession") { () -> Bool in
      self.configureAudioSession()
      self.startEnginePlayback()
      self.isSessionActive = true
      return true
    }

    Function("stopPlaybackSession") { () -> Void in
      self.stopPlayback()
      if self.engine.isRunning {
        self.engine.stop()
      }
      self.deactivateAudioSession()
      self.isSessionActive = false
    }

    /// Flush the player queue immediately (barge-in / end of turn cleanup).
    Function("clearPlayback") { () -> Void in
      self.playerQueue.sync {
        self.playerNode.stop()
        self.scheduledFrames = 0
      }
      if self.isSessionActive, !self.engine.isRunning {
        do { try self.engine.start() } catch {
          self.emitError("Could not restart engine after clear: \(error.localizedDescription)")
        }
      }
    }

    // ── Capture (mic → base64 PCM16) ─────────────────────────
    Function("startCapture") { () -> Bool in
      guard self.isSessionActive else {
        self.emitError("Audio session not active")
        return false
      }
      guard !self.isCapturing else { return true }

      let inputNode = self.engine.inputNode
      let recordingFormat = inputNode.outputFormat(forBus: 0)

      // Remove any previous tap, then install ours.
      inputNode.removeTap(onBus: 0)
      inputNode.installTap(onBus: 0, bufferSize: 4096, format: recordingFormat) { buffer, _ in
        self.handleCapturedBuffer(buffer, from: recordingFormat)
      }

      do {
        if !self.engine.isRunning {
          try self.engine.start()
        }
      } catch {
        self.emitError("Could not start audio engine: \(error.localizedDescription)")
        return false
      }

      self.isCapturing = true
      self.emitState("capturing")
      return true
    }

    Function("stopCapture") { () -> Void in
      self.stopCapture()
    }

    // ── Playback (PCM16 base64 → speakers/glasses) ──────────
    AsyncFunction("enqueueAudio") { (base64: String) -> Bool in
      guard let pcmData = Data(base64Encoded: base64), !pcmData.isEmpty else {
        return false
      }
      self.schedulePcm16(pcmData)
      return true
    }

    Function("interrupt") { () -> Void in
      // Barge-in: flush everything currently scheduled so Grok stops talking
      // immediately when the user starts speaking.
      self.playerQueue.sync {
        self.playerNode.stop()
        self.scheduledFrames = 0
      }
      if self.isSessionActive, !self.engine.isRunning {
        do { try self.engine.start() } catch {
          self.emitError("Could not restart engine after interrupt: \(error.localizedDescription)")
        }
      }
      self.emitState("interrupted")
    }

    Function("setMuted") { (muted: Bool) -> Void in
      self.playerNode.volume = muted ? 0.0 : 1.0
    }
  }

  // MARK: – Capture

  private func stopCapture() {
    guard isCapturing else { return }
    let inputNode = engine.inputNode
    inputNode.removeTap(onBus: 0)
    isCapturing = false
  }

  private func handleCapturedBuffer(_ buffer: AVAudioPCMBuffer, from format: AVAudioFormat) {
    // Lazily build the input→pcm16 converter the first time.
    if converter == nil {
      converter = AVAudioConverter(from: format, to: pcm16Format)
    }
    guard let converter = converter else { return }

    // Estimate output frame capacity (resampling ratio).
    let ratio = pcm16Format.sampleRate / format.sampleRate
    let capacity = AVAudioFrameCount(Double(buffer.frameLength) * ratio) + 1024

    guard let outBuffer = AVAudioPCMBuffer(pcmFormat: pcm16Format, frameCapacity: capacity) else {
      return
    }

    var error: NSError?
    var converted = false
    let inputBlock: AVAudioConverterInputBlock = { _, outStatus in
      outStatus.pointee = .haveData
      return buffer
    }
    converter.convert(to: outBuffer, error: &error, withInputFrom: inputBlock) { status in
      converted = true
    }

    guard converted, error == nil, outBuffer.frameLength > 0 else { return }

    // Read interleaved Int16 bytes and ship as base64.
    guard let raw = outBuffer.int16ChannelData?.pointee else { return }
    let byteCount = Int(outBuffer.frameLength) * MemoryLayout<Int16>.size
    let data = Data(bytes: raw, count: byteCount)
    let base64 = data.base64EncodedString()
    sendEvent("onAudioData", ["base64": base64, "bytes": byteCount])
  }

  // MARK: – Playback

  private func startEnginePlayback() {
    guard !engine.attachedNodes.contains(playerNode) else {
      ensureEngineRunning()
      return
    }
    engine.attach(playerNode)
    // Convert pcm16 → standard deinterleaved float for the engine.
    guard let floatFormat = AVAudioFormat(
      commonFormat: .pcmFormatFloat32,
      sampleRate: 24000,
      channels: 1,
      interleaved: false
    ) else {
      emitError("Could not create player float format")
      return
    }

    engine.connect(playerNode, to: engine.mainMixerNode, format: floatFormat)
    ensureEngineRunning()
    playerNode.play()
    isPlaying = true
  }

  private func ensureEngineRunning() {
    if !engine.isRunning {
      do {
        try engine.start()
      } catch {
        emitError("Could not start playback engine: \(error.localizedDescription)")
      }
    }
  }

  /// Schedule a chunk of PCM16 audio for playback. A per-chunk AVAudioConverter
  /// (pcm16 float) is used because AVAudioPlayerNode schedules float buffers.
  private func schedulePcm16(_ data: Data) {
    guard isSessionActive else { return }
    ensureEngineRunning()

    let frameCount = data.count / MemoryLayout<Int16>.size
    guard frameCount > 0 else { return }

    guard let int16Buffer = AVAudioPCMBuffer(pcmFormat: pcm16Format, frameCapacity: AVAudioFrameCount(frameCount)) else {
      return
    }
    int16Buffer.frameLength = AVAudioFrameCount(frameCount)
    data.withUnsafeBytes { raw in
      if let src = raw.baseAddress?.assumingMemoryBound(to: Int16.self),
         let dst = int16Buffer.int16ChannelData?.pointee {
        dst.update(from: src, count: frameCount)
      }
    }

    guard let floatFormat = AVAudioFormat(
      commonFormat: .pcmFormatFloat32,
      sampleRate: 24000,
      channels: 1,
      interleaved: false
    ) else { return }

    guard let floatBuffer = AVAudioPCMBuffer(pcmFormat: floatFormat, frameCapacity: AVAudioFrameCount(frameCount)) else {
      return
    }
    floatBuffer.frameLength = AVAudioFrameCount(frameCount)

    guard let chunkConverter = AVAudioConverter(from: pcm16Format, to: floatFormat) else { return }
    var conversionError: NSError?
    let inputBlock: AVAudioConverterInputBlock = { _, outStatus in
      outStatus.pointee = .endOfStream
      return int16Buffer
    }
    var ok = false
    chunkConverter.convert(to: floatBuffer, error: &conversionError, withInputFrom: inputBlock) { _ in
      ok = true
    }
    guard ok, conversionError == nil else { return }

    playerQueue.sync {
      // If too much is already queued, drop the oldest segment to avoid drift.
      if scheduledFrames > maxScheduledFrames {
        playerNode.stop()
        scheduledFrames = 0
        ensureEngineRunning()
        playerNode.play()
      }
      scheduledFrames += frameCount
    }

    playerNode.scheduleBuffer(floatBuffer, completionHandler: { [weak self] in
      self?.playerQueue.sync {
        self?.scheduledFrames = max(0, (self?.scheduledFrames ?? 0) - frameCount)
      }
    })
  }

  private func stopPlayback() {
    playerQueue.sync {
      playerNode.stop()
      scheduledFrames = 0
    }
    isPlaying = false
  }

  // MARK: – Audio session (Bluetooth routing identical to AudioService.ts)

  private func configureAudioSession() {
    let session = AVAudioSession.sharedInstance()
    do {
      try session.setCategory(
        .playAndRecord,
        mode: .voiceChat,
        options: [.allowBluetooth, .allowBluetoothA2DP, .allowAirPlay, .defaultToSpeaker]
      )
      try session.setActive(true, options: [.notifyOthersOnDeactivation])
      isSessionActive = true
    } catch {
      emitError("Audio session config failed: \(error.localizedDescription)")
    }
  }

  private func deactivateAudioSession() {
    do {
      try AVAudioSession.sharedInstance().setActive(
        false,
        options: [.notifyOthersOnDeactivation]
      )
    } catch {
      // Non-fatal: session may already be inactive.
    }
  }

  // MARK: – Events

  private func emitState(_ state: String) {
    sendEvent("onStateChange", ["state": state])
  }

  private func emitError(_ message: String) {
    sendEvent("onError", ["message": message])
  }
}
