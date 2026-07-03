import { LogService } from '../LogService';

/**
 * Connection state surfaced up to the orchestrator / UI.
 * `connecting` → handshaking; `connected` → ready / listening; `speaking` →
 * Grok is streaming audio back; `error` → terminal for this session.
 */
export type GrokRealtimeState = 'connecting' | 'connected' | 'speaking' | 'error';

export interface GrokSessionOptions {
  /** Ephemeral token minted by the proxy (xai-client-secret.*). */
  ephemeralToken: string;
  /** Full ws URL including ?model=, e.g. wss://api.x.ai/v1/realtime?model=grok-voice-latest */
  wsUrl: string;
  /** Grok native voice id (eve/ara/rex/sal/leo). */
  voice: string;
  /** System instructions for the session (KAIRO prompt + user profile). */
  instructions: string;
}

export interface GrokRealtimeCallbacks {
  onStateChange?: (state: GrokRealtimeState) => void;
  /** Final transcript of what the user said (when available). */
  onUserTranscript?: (text: string) => void;
  /** Text transcript of Grok's spoken response (accumulated). */
  onResponseDelta?: (text: string) => void;
  /** Final full transcript of Grok's response. */
  onResponseFinal?: (text: string) => void;
  /** PCM16 base64 audio chunk from Grok to play. */
  onAudioDelta?: (base64: string) => void;
  /** User started speaking (VAD) → good moment to barge-in / mute playback. */
  onSpeechStarted?: () => void;
  /** User stopped speaking (VAD). */
  onSpeechStopped?: () => void;
  onError?: (message: string) => void;
}

/**
 * Client for the xAI Realtime Voice Agent API (OpenAI-Realtime-compatible).
 *
 * Lifecycle:
 *   const c = new GrokRealtimeClient(callbacks);
 *   await c.connect(options);          // opens WS, sends session.update
 *   c.sendAudio(base64Pcm16);          // push mic frames as they arrive
 *   await c.interrupt();               // barge-in
 *   await c.disconnect();              // clean close
 *
 * Auth uses the ephemeral token via the WebSocket subprotocol
 * `xai-client-secret.<token>` so the master API key never reaches the device.
 */
export class GrokRealtimeClient {
  private ws: WebSocket | null = null;
  private callbacks: GrokRealtimeCallbacks;
  private state: GrokRealtimeState | null = null;
  private responseTextBuffer = '';
  private pingInterval: ReturnType<typeof setInterval> | null = null;

  constructor(callbacks: GrokRealtimeCallbacks = {}) {
    this.callbacks = callbacks;
  }

  get isConnected(): boolean {
    return this.ws !== null && this.state === 'connected';
  }

  connect(options: GrokSessionOptions): Promise<void> {
    return new Promise((resolve, reject) => {
      this.closeExisting();
      this.setState('connecting');
      LogService.info('GrokRealtime', `Connecting to ${options.wsUrl} (voice=${options.voice})`);

      // The xAI realtime endpoint authenticates the client with the ephemeral
      // secret as a WebSocket subprotocol. Browsers/RN send it in Sec-WebSocket-Protocol.
      const ws = new WebSocket(options.wsUrl, `xai-client-secret.${options.ephemeralToken}`);
      this.ws = ws;

      let opened = false;

      ws.onopen = () => {
        opened = true;
        LogService.info('GrokRealtime', 'WebSocket open — sending session.update');
        this.sendSessionUpdate(options);
        this.setState('connected');
        // Keep the connection warm against idle proxies.
        this.pingInterval = setInterval(() => this.sendRaw({ type: 'ping' }), 25000);
        resolve();
      };

      ws.onmessage = (event) => this.handleMessage(event.data);

      ws.onerror = (event) => {
        const detail = (event as unknown as { message?: string }).message ?? 'WebSocket error';
        LogService.error('GrokRealtime', `WS error: ${detail}`);
        if (!opened) {
          reject(new Error('No se pudo conectar con Grok. Revisa tu conexión.'));
        } else {
          this.fail(`Error de conexión con Grok: ${detail}`);
        }
      };

      ws.onclose = (event) => {
        LogService.info('GrokRealtime', `WS closed (code=${event.code} reason="${event.reason ?? ''}")`);
        this.clearPing();
        if (this.state !== 'error') {
          this.setState('connected'); // still surface as idle; orchestrator decides next move
        }
      };
    });
  }

  /** Send captured mic PCM16 (base64) upstream. */
  sendAudio(base64Pcm16: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.sendRaw({ type: 'input_audio_buffer.append', audio: base64Pcm16 });
  }

  /** Ask Grok to respond to whatever audio has been committed (used with server VAD
   *  this is normally triggered automatically, but it's available for manual turns). */
  commitAndRespond(): void {
    this.sendRaw({ type: 'input_audio_buffer.commit' });
    this.sendRaw({ type: 'response.create', response: { modalities: ['text', 'audio'] } });
  }

  /** Barge-in: cancel the in-flight response and clear any committed audio. */
  interrupt(): void {
    this.sendRaw({ type: 'response.cancel' });
    this.sendRaw({ type: 'output_audio_buffer.clear' });
    this.responseTextBuffer = '';
  }

  async disconnect(): Promise<void> {
    this.clearPing();
    if (this.ws) {
      try {
        this.sendRaw({ type: 'input_audio_buffer.clear' });
      } catch {}
      const ws = this.ws;
      this.ws = null;
      try {
        ws.close();
      } catch {}
    }
    this.state = null;
    LogService.info('GrokRealtime', 'Disconnected');
  }

  // ── Internals ──────────────────────────────────────────────

  private sendSessionUpdate(options: GrokSessionOptions): void {
    this.sendRaw({
      type: 'session.update',
      session: {
        voice: options.voice,
        instructions: options.instructions,
        input_audio_format: 'pcm16',
        output_audio_format: 'pcm16',
        input_audio_transcription: { model: 'whisper-1' },
        turn_detection: { type: 'server_vad', threshold: 0.5, silence_duration_ms: 500 },
        modalities: ['text', 'audio'],
      },
    });
  }

  private handleMessage(data: string | ArrayBuffer | Blob): void {
    let raw: unknown;
    try {
      if (typeof data === 'string') {
        raw = JSON.parse(data);
      } else {
        // Binary frames are not expected from the realtime API; ignore gracefully.
        return;
      }
    } catch {
      return;
    }

    const msg = raw as { type?: string; [key: string]: unknown };
    switch (msg.type) {
      case 'response.audio.delta': {
        const delta = (msg as { delta?: string }).delta;
        if (typeof delta === 'string') {
          this.setState('speaking');
          this.callbacks.onAudioDelta?.(delta);
        }
        break;
      }
      case 'response.audio_transcript.delta': {
        const delta = (msg as { delta?: string }).delta;
        if (typeof delta === 'string') {
          this.responseTextBuffer += delta;
          this.callbacks.onResponseDelta?.(this.responseTextBuffer);
        }
        break;
      }
      case 'response.audio_transcript.done': {
        const transcript = (msg as { transcript?: string }).transcript ?? this.responseTextBuffer;
        this.responseTextBuffer = '';
        this.callbacks.onResponseFinal?.(transcript);
        this.setState('connected');
        break;
      }
      case 'response.done': {
        this.setState('connected');
        break;
      }
      case 'conversation.item.input_audio_transcription.completed': {
        const transcript = (msg as { transcript?: string }).transcript;
        if (typeof transcript === 'string' && transcript.trim()) {
          this.callbacks.onUserTranscript?.(transcript);
        }
        break;
      }
      case 'input_audio_buffer.speech_started': {
        this.callbacks.onSpeechStarted?.();
        break;
      }
      case 'input_audio_buffer.speech_stopped': {
        this.callbacks.onSpeechStopped?.();
        break;
      }
      case 'error': {
        const errMsg = (msg as { error?: { message?: string } }).error?.message ?? 'Error desconocido';
        LogService.error('GrokRealtime', `Server error: ${errMsg}`);
        this.callbacks.onError?.(errMsg);
        break;
      }
      default:
        // Many event types (rate_limits.updated, session.created, etc.) are
        // intentionally ignored — they're not needed for the talk flow.
        break;
    }
  }

  private sendRaw(payload: unknown): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    try {
      this.ws.send(JSON.stringify(payload));
    } catch (error) {
      LogService.warn('GrokRealtime', `Failed to send: ${(error as Error).message}`);
    }
  }

  private setState(state: GrokRealtimeState): void {
    if (this.state === state) return;
    this.state = state;
    this.callbacks.onStateChange?.(state);
  }

  private fail(message: string): void {
    this.setState('error');
    this.callbacks.onError?.(message);
  }

  private clearPing(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
  }

  private closeExisting(): void {
    if (this.ws) {
      try { this.ws.onmessage = null; this.ws.onerror = null; this.ws.onclose = null; this.ws.onopen = null; } catch {}
      try { this.ws.close(); } catch {}
      this.ws = null;
    }
    this.clearPing();
  }
}
