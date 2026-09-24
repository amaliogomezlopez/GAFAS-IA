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

  // Ring-buffer-ish accounting for player scheduling. `playerGeneration` is
  // bumped on every flush so completion handlers of flushed buffers can't
  // corrupt the count. Never call playerNode.stop() while on playerQueue:
  // stop() fires completion handlers, which also hop onto playerQueue.
  private let playerQueue = DispatchQueue(label: "smartglasses.grok.player")
  private var scheduledFrames: Int = 0
  private var playerGeneration: Int = 0
  // Safety valve only. Kokoro/Grok deliver audio much faster than real time,
  // so a whole answer is legitimately queued ahead; the old 2s cap flushed
  // everything mid-sentence whenever a reply was longer than two seconds.
  private let maxScheduledFrames = 24000 * 90

  private let floatFormat: AVAudioFormat = AVAudioFormat(
    commonFormat: .pcmFormatFloat32,
    sampleRate: 24000,
    channels: 1,
    interleaved: false
  )!

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
      self.flushPlayer()
      if self.isSessionActive {
        self.ensureEngineRunning()
        self.playerNode.play()
      }
    }

    /// Milliseconds of audio still scheduled on the player (0 when drained).
    Function("getBufferedDurationMs") { () -> Double in
      let frames = self.playerQueue.sync { self.scheduledFrames }
      return Double(frames) / 24.0
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
      // immediately when the user starts speaking. The node is restarted so the
      // next response plays (a stopped AVAudioPlayerNode stays silent).
      self.flushPlayer()
      if self.isSessionActive {
        self.ensureEngineRunning()
        self.playerNode.play()
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
    if !engine.attachedNodes.contains(playerNode) {
      engine.attach(playerNode)
      // Convert pcm16 → standard deinterleaved float for the engine.
      engine.connect(playerNode, to: engine.mainMixerNode, format: floatFormat)
    }
    ensureEngineRunning()
    // Always (re)start the node: after stopPlaybackSession / clearPlayback it
    // is stopped, and buffers scheduled on a stopped node are never heard.
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
    if !playerNode.isPlaying {
      playerNode.play()
    }

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

    let overflow = playerQueue.sync { scheduledFrames > maxScheduledFrames }
    if overflow {
      // Something is badly out of sync (e.g. the route died); start fresh
      // rather than letting latency grow without bound.
      flushPlayer()
      ensureEngineRunning()
      playerNode.play()
    }

    let generation: Int = playerQueue.sync {
      scheduledFrames += frameCount
      return playerGeneration
    }

    playerNode.scheduleBuffer(floatBuffer, completionCallbackType: .dataPlayedBack) { [weak self] _ in
      guard let self = self else { return }
      self.playerQueue.async {
        guard self.playerGeneration == generation else { return }
        self.scheduledFrames = max(0, self.scheduledFrames - frameCount)
        if self.scheduledFrames == 0 {
          self.sendEvent("onPlaybackFinished", [:])
        }
      }
    }
  }

  /// Drop everything scheduled on the player and reset the accounting.
  private func flushPlayer() {
    playerQueue.sync {
      playerGeneration += 1
      scheduledFrames = 0
    }
    playerNode.stop()
  }

  private func stopPlayback() {
    flushPlayer()
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
