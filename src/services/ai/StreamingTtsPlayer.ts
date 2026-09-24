import { getProxyAuthHeaders } from '../proxy-auth';
import { API_ENDPOINTS } from '../../constants';
import { LogService } from '../LogService';
import { sanitizeForSpeech } from './speechText';
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

// Split on sentence boundaries but also flush long clauses so a long sentence
// doesn't block playback. Mirrors the existing TTSService splitter behaviour
// but tuned a little tighter for latency.
const SEGMENT_MATCHER = /[^.!?¡¿\n]{16,}?[.!?]+(?:\s+|$)|[^\n]{60,}(?:,|;|:|\n|\s$)/g;
const MAX_SEGMENT_CHARS = 220;
const PCM_SAMPLE_RATE = 24000;
const PCM_BYTES_PER_SECOND = PCM_SAMPLE_RATE * 2;
/** Upper bound on how long finish() waits for the tail to play out. */
const MAX_DRAIN_WAIT_MS = 30_000;
const DRAIN_POLL_MS = 60;

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

/** Binary string for btoa, built in slices so long chunks don't blow the stack. */
function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const step = 0x2000;
  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + step)));
  }
  return btoa(binary);
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class StreamingTtsPlayer {
  private buffer = '';
  private stopped = false;
  private nativeAvailable: boolean;
  private opts: StreamingTtsPlayerOptions;
  private firstAudioFired = false;
  /** Odd trailing byte of a network chunk, prepended to the next one. */
  private carryByte: number | null = null;
  /** When the audio queued so far is expected to finish playing (ms epoch). */
  private playbackEndsAt = 0;

  // Segments are synthesized sequentially (one Kokoro request at a time), but
  // each segment's PCM is streamed into the ring buffer the moment it arrives,
  // so playback of segment N overlaps with synthesis of segment N+1 and with
  // the LLM stream still producing text.
  private queue: Promise<void> = Promise.resolve();
  private activeControllers = new Set<AbortController>();

  constructor(opts: StreamingTtsPlayerOptions) {
    this.opts = opts;
    this.nativeAvailable = GrokAudio.isAvailable;
    if (!this.nativeAvailable) {
      LogService.warn('StreamingTTS', 'Native ring-buffer module unavailable — streaming TTS disabled.');
    }
    opts.signal?.addEventListener('abort', () => this.stop(), { once: true });
  }

  /** True once any PCM reached the native player during this turn. */
  get hasPlayedAudio(): boolean {
    return this.firstAudioFired;
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
    await this.waitForDrain();
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.buffer = '';
    // Abort every in-flight Kokoro fetch immediately so barge-in is instant.
    this.activeControllers.forEach((c) => { try { c.abort(); } catch {} });
    this.activeControllers.clear();
    try { GrokAudio.clearPlayback(); } catch {}
  }

  /**
   * The fetch loop finishes as soon as the last bytes are *queued*, which is
   * well before they are *heard* (Kokoro runs faster than real time). Wait
   * for the native buffer to empty so the caller doesn't tear the session
   * down under the last sentence.
   */
  private async waitForDrain(): Promise<void> {
    const deadline = Date.now() + MAX_DRAIN_WAIT_MS;
    while (!this.stopped && Date.now() < deadline) {
      // Prefer the native buffer level; older native builds report -1, in
      // which case fall back to the duration of the PCM we queued.
      const nativeMs = GrokAudio.getBufferedDurationMs();
      const remainingMs = nativeMs >= 0 ? nativeMs : this.playbackEndsAt - Date.now();
      if (remainingMs <= 0) return;
      await wait(Math.min(DRAIN_POLL_MS, remainingMs));
    }
  }

  private enqueueSegment(rawText: string): void {
    const text = sanitizeForSpeech(rawText);
    if (!text || this.stopped || this.opts.signal?.aborted) return;
    // Chain so requests are sequential (one in flight), but PCM streaming
    // inside each keeps playback overlapping with the next request's wait.
    this.queue = this.queue
      .then(() => this.synthesizeAndPlay(text))
      .catch((err) => {
        if (!this.stopped) {
          LogService.warn('StreamingTTS', `Segment failed: ${(err as Error).message}`);
        }
      });
  }

  private async synthesizeAndPlay(text: string): Promise<void> {
    if (this.stopped || this.opts.signal?.aborted) return;
    this.opts.onChunkStart?.(text);

    const controller = new AbortController();
    this.activeControllers.add(controller);
    this.carryByte = null;
    try {
      const headers = await getProxyAuthHeaders({ 'Content-Type': 'application/json' });
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
          signal: controller.signal,
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
            try { await reader.cancel(); } catch {}
            return;
          }
          const { done, value } = await reader.read();
          if (done) break;
          if (value && value.byteLength > 0) this.feedPcmChunk(value);
        }
      } finally {
        try { reader.releaseLock(); } catch {}
      }
    } finally {
      this.activeControllers.delete(controller);
    }
  }

  private feedPcmChunk(bytes: Uint8Array): void {
    if (this.stopped) return;
    // PCM16 samples are 2 bytes, but network chunks can split a sample in
    // half. Carry the odd byte over instead of dropping it, which would shift
    // every following sample and turn the rest of the sentence into noise.
    let data = bytes;
    if (this.carryByte !== null) {
      data = new Uint8Array(bytes.byteLength + 1);
      data[0] = this.carryByte;
      data.set(bytes, 1);
      this.carryByte = null;
    }
    if (data.byteLength % 2 === 1) {
      this.carryByte = data[data.byteLength - 1];
      data = data.subarray(0, data.byteLength - 1);
    }
    if (data.byteLength === 0) return;

    const durationMs = (data.byteLength / PCM_BYTES_PER_SECOND) * 1000;
    this.playbackEndsAt = Math.max(this.playbackEndsAt, Date.now()) + durationMs;

    if (!this.firstAudioFired) {
      this.firstAudioFired = true;
      this.opts.onFirstAudio?.();
    }
    GrokAudio.enqueueAudio(bytesToBase64(data)).catch((err) =>
      LogService.warn('StreamingTTS', `Enqueue failed: ${(err as Error).message}`),
    );
  }
}
