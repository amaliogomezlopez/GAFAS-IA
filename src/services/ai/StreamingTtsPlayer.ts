import { getProxyAuthHeaders } from '../proxy-auth';
import { API_ENDPOINTS } from '../../constants';
import { LogService } from '../LogService';
import GrokAudio from '../../../modules/grok-audio/src/GrokAudio';

/**
 * StreamingTtsPlayer — the low-latency TTS path for the cheap pipeline.
 *
 * It implements the hypercheap-voiceAI pattern: synthesize each sentence as
 * soon as it is available (from the LLM stream), stream the resulting raw PCM
 * straight into the native ring buffer, and start the NEXT sentence's request
 * while the current one is still playing. This overlaps LLM generation, TTS
 * synthesis and playback, which is what brings end-of-speech → first-audio
 * under one second.
 *
 * Contract (same surface the existing `StreamingSpeaker` exposes so the
 * orchestrator can swap it in transparently):
 *   pushText(delta)   — feed LLM deltas; ready sentences are split off & sent
 *   finish()          — flush the tail and await playback drain
 *   stop()            — barge-in: abort in-flight fetches + clear the player
 */

export interface StreamingTtsPlayerOptions {
  voice: string;
  speed?: number;
  signal?: AbortSignal;
  onFirstAudio?: () => void;   // first PCM chunk reached the player
  onChunkStart?: (text: string) => void;
}

interface SegmentTask {
  text: string;
  promise: Promise<void>;
  controller: AbortController;
}

// Split on sentence boundaries but also flush long clauses so a long sentence
// doesn't block playback. Mirrors the existing TTSService splitter behaviour
// but tuned a little tighter for latency.
const SEGMENT_MATCHER = /[^.!?¡¿\n]{16,}?[.!?]+(?:\s+|$)|[^\n]{60,}(?:,|;|:|\n|\s$)/g;
const MAX_SEGMENT_CHARS = 220;

function splitSentences(buffer: string): { segments: string[]; rest: string } {
  const segments: string[] = [];
  let lastEnd = 0;
  let match: RegExpExecArray | null;
  SEGMENT_MATCHER.lastIndex = 0;
  while ((match = SEGMENT_MATCHER.exec(buffer)) !== null) {
    let chunk = match[0].trim();
    // Hard-cap very long clauses so TTS/latency stays bounded.
    while (chunk.length > MAX_SEGMENT_CHARS) {
      segments.push(chunk.slice(0, MAX_SEGMENT_CHARS));
      chunk = chunk.slice(MAX_SEGMENT_CHARS);
    }
    if (chunk.length >= 12) {
      segments.push(chunk);
      lastEnd = match.index + match[0].length;
    }
  }
  return { segments, rest: buffer.slice(lastEnd) };
}

export class StreamingTtsPlayer {
  private buffer = '';
  private stopped = false;
  private nativeAvailable: boolean;
  private opts: StreamingTtsPlayerOptions;
  private firstAudioFired = false;

  // Segments are synthesized sequentially (one Kokoro request at a time), but
  // each segment's PCM is streamed into the ring buffer the moment it arrives,
  // so playback of segment N overlaps with synthesis of segment N+1 and with
  // the LLM stream still producing text.
  private queue: Promise<void> = Promise.resolve();
  private activeControllers: AbortController[] = [];

  constructor(opts: StreamingTtsPlayerOptions) {
    this.opts = opts;
    this.nativeAvailable = GrokAudio.isAvailable;
    if (!this.nativeAvailable) {
      LogService.warn('StreamingTTS', 'Native ring-buffer module unavailable — streaming TTS disabled.');
    }
  }

  pushText(delta: string): void {
    if (!delta || this.stopped || !this.nativeAvailable) return;
    this.buffer += delta;
    const { segments, rest } = splitSentences(this.buffer);
    this.buffer = rest;
    segments.forEach((seg) => this.enqueueSegment(seg));
  }

  async finish(): Promise<void> {
    if (this.stopped) return;
    const tail = this.buffer.trim();
    this.buffer = '';
    if (tail) this.enqueueSegment(tail);
    await this.queue;
  }

  stop(): void {
    this.stopped = true;
    this.buffer = '';
    // Abort every in-flight Kokoro fetch immediately so barge-in is instant.
    this.activeControllers.forEach((c) => { try { c.abort(); } catch {} });
    this.activeControllers = [];
    try { GrokAudio.clearPlayback(); } catch {}
  }

  private enqueueSegment(text: string): void {
    if (this.stopped || this.opts.signal?.aborted) return;
    const controller = new AbortController();
    this.activeControllers.push(controller);
    // Chain so requests are sequential (one in flight), but PCM streaming
    // inside each keeps playback overlapping with the next request's wait.
    this.queue = this.queue
      .then(() => this.synthesizeAndPlay(text, controller))
      .catch((err) => {
        if (!this.stopped) {
          LogService.warn('StreamingTTS', `Segment failed: ${(err as Error).message}`);
        }
      });
  }

  private async synthesizeAndPlay(text: string, controller: AbortController): Promise<void> {
    if (this.stopped || this.opts.signal?.aborted || controller.signal.aborted) return;
    this.opts.onChunkStart?.(text);

    const headers = await getProxyAuthHeaders({ 'Content-Type': 'application/json' });
    const mergedSignal = this.mergeSignals(controller.signal);

    let response: Response;
    try {
      response = await fetch(API_ENDPOINTS.proxy.ttsKokoroStream, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          text,
          voice: this.opts.voice,
          speed: this.opts.speed ?? 1.05,
        }),
        signal: mergedSignal,
      });
    } catch (err) {
      if (this.stopped || controller.signal.aborted) return;
      throw new Error(`Kokoro stream fetch failed: ${(err as Error).message}`);
    }

    if (!response.ok || !response.body) {
      throw new Error(`Kokoro stream HTTP ${response.status}`);
    }

    // Read the raw PCM16 stream chunk by chunk; hand each chunk to the native
    // ring buffer immediately. Playback starts on the first chunk.
    const reader = response.body.getReader();
    try {
      for (;;) {
        if (this.stopped || controller.signal.aborted) {
          try { reader.cancel(); } catch {}
          return;
        }
        const { done, value } = await reader.read();
        if (done) break;
        if (!value || value.byteLength === 0) continue;
        this.feedPcmChunk(value);
      }
    } finally {
      try { reader.releaseLock(); } catch {}
    }
  }

  private feedPcmChunk(bytes: Uint8Array): void {
    if (this.stopped) return;
    // The native enqueueAudio expects base64 PCM16; convert the raw chunk.
    // React Native's btoa needs a binary string; build it from the byte view.
    let binary = '';
    const chunk = bytes.byteLength % 2 === 0 ? bytes : bytes.slice(0, bytes.byteLength - 1);
    for (let i = 0; i < chunk.byteLength; i++) {
      binary += String.fromCharCode(chunk[i]);
    }
    const base64 = btoa(binary);
    if (!this.firstAudioFired) {
      this.firstAudioFired = true;
      this.opts.onFirstAudio?.();
    }
    GrokAudio.enqueueAudio(base64).catch((err) =>
      LogService.warn('StreamingTTS', `Enqueue failed: ${(err as Error).message}`),
    );
  }

  /** Combine the segment controller with the global abort signal. */
  private mergeSignals(segmentSignal: AbortSignal): AbortSignal {
    if (!this.opts.signal) return segmentSignal;
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    this.opts.signal.addEventListener('abort', onAbort, { once: true });
    segmentSignal.addEventListener('abort', onAbort, { once: true });
    return controller.signal;
  }
}
