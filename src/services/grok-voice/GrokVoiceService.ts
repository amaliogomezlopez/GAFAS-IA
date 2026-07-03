import { API_ENDPOINTS } from '../../constants';
import { getProxyAuthHeaders } from '../proxy-auth';
import { LogService } from '../LogService';
import { GrokRealtimeClient, GrokRealtimeState } from './GrokRealtimeClient';
import GrokAudio from '../../../modules/grok-audio/src/GrokAudio';
import type { GrokAudioSubscription } from '../../../modules/grok-audio/src/GrokAudio';
import { Platform } from 'react-native';
import type { AppSettings, ConversationEntry, UserProfile } from '../../types';

export type GrokSessionState = 'idle' | 'connecting' | 'connected' | 'listening' | 'speaking' | 'error';

export interface GrokVoiceCallbacks {
  onStateChange?: (state: GrokSessionState) => void;
  onUserTranscript?: (text: string) => void;
  onResponseDelta?: (text: string) => void;
  onResponseFinal?: (text: string) => void;
  onConversationEntry?: (entry: ConversationEntry) => void;
  onError?: (message: string) => void;
}

interface RealtimeSessionResponse {
  ephemeral_token: string;
  model: string;
  ws_url: string;
  expires_in: number;
}

/**
 * Orchestrates a Grok realtime voice session — the voice-mode counterpart of
 * PipelineOrchestrator. It is intentionally separate so the existing STT→LLM→TTS
 * pipeline stays untouched.
 *
 * Flow:
 *   startSession → fetch ephemeral token from proxy → open WS to x.ai →
 *   start native audio capture → relay mic PCM up and response PCM down →
 *   on stop, tear everything down cleanly.
 */

const _state: { value: GrokSessionState } = { value: 'idle' };
let _client: GrokRealtimeClient | null = null;
let _audioSubs: GrokAudioSubscription[] = [];
let _currentCallbacks: GrokVoiceCallbacks | null = null;
let _userTranscriptBuffer = '';
let _responseTranscriptBuffer = '';

function setState(next: GrokSessionState): void {
  if (_state.value === next) return;
  _state.value = next;
  _currentCallbacks?.onStateChange?.(next);
}

function mapRealtimeState(state: GrokRealtimeState): GrokSessionState {
  if (state === 'connecting') return 'connecting';
  if (state === 'error') return 'error';
  if (state === 'speaking') return 'speaking';
  return 'listening';
}

function buildInstructions(settings: AppSettings, profile: UserProfile | null): string {
  let instructions = settings.systemPrompt || 'Eres KAIRO, el asistente de voz de unas gafas inteligentes.';
  instructions += '\nResponde de forma breve, clara y conversacional por voz, en el idioma del usuario.';
  if (profile?.name) {
    instructions += `\nEl usuario se llama ${profile.name}. Llámale por su nombre de forma natural.`;
  }
  return instructions;
}

function flushConversationEntry(): void {
  const userText = _userTranscriptBuffer.trim();
  const assistantText = _responseTranscriptBuffer.trim();
  if (!userText && !assistantText) return;
  const entry: ConversationEntry = {
    id: `grok_${Date.now()}`,
    userMessage: {
      id: `grok_u_${Date.now()}`,
      role: 'user',
      content: userText,
      timestamp: Date.now(),
    },
    assistantMessage: {
      id: `grok_a_${Date.now()}`,
      role: 'assistant',
      content: assistantText,
      timestamp: Date.now(),
    },
    profileId: 'grok',
    createdAt: Date.now(),
  };
  _currentCallbacks?.onConversationEntry?.(entry);
  _userTranscriptBuffer = '';
  _responseTranscriptBuffer = '';
}

async function fetchEphemeralToken(): Promise<RealtimeSessionResponse> {
  const headers = await getProxyAuthHeaders({ 'Content-Type': 'application/json' });
  const resp = await fetch(API_ENDPOINTS.proxy.xaiRealtimeSession, {
    method: 'POST',
    headers,
    body: JSON.stringify({}),
  });
  if (!resp.ok) {
    let detail = '';
    try { detail = (await resp.json())?.error ?? ''; } catch {}
    throw new Error(detail || `El proxy rechazó la sesión de Grok (${resp.status}).`);
  }
  return (await resp.json()) as RealtimeSessionResponse;
}

export const GrokVoice = {
  isActive(): boolean {
    return _state.value !== 'idle' && _state.value !== 'error';
  },

  getState(): GrokSessionState {
    return _state.value;
  },

  async startSession(
    settings: AppSettings,
    profile: UserProfile | null,
    callbacks: GrokVoiceCallbacks,
  ): Promise<void> {
    if (this.isActive()) {
      LogService.warn('GrokVoice', `startSession ignored — state=${_state.value}`);
      return;
    }
    if (!GrokAudio.isAvailable) {
      callbacks.onError?.(
        Platform.OS === 'ios'
          ? 'El módulo de voz Grok no está disponible en este build. Recompila con un dev-client nativo.'
          : 'El modo de voz Grok realtime solo está disponible en iOS por ahora.'
      );
      return;
    }

    _currentCallbacks = callbacks;
    _userTranscriptBuffer = '';
    _responseTranscriptBuffer = '';
    setState('connecting');
    LogService.info('GrokVoice', 'Starting realtime session…');

    // 1) Ephemeral token from the proxy (master key stays server-side).
    let session: RealtimeSessionResponse;
    try {
      session = await fetchEphemeralToken();
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'No se pudo obtener la sesión de Grok.';
      LogService.error('GrokVoice', `Token fetch failed: ${msg}`);
      setState('error');
      callbacks.onError?.(msg);
      return;
    }

    // 2) Wire realtime callbacks before connecting.
    _client = new GrokRealtimeClient({
      onStateChange: (rs) => setState(mapRealtimeState(rs)),
      onUserTranscript: (text) => {
        _userTranscriptBuffer = text;
        callbacks.onUserTranscript?.(text);
      },
      onResponseDelta: (text) => {
        _responseTranscriptBuffer = text;
        callbacks.onResponseDelta?.(text);
      },
      onResponseFinal: (text) => {
        _responseTranscriptBuffer = text;
        callbacks.onResponseFinal?.(text);
        flushConversationEntry();
      },
      onAudioDelta: (base64) => {
        GrokAudio.enqueueAudio(base64).catch((e) =>
          LogService.warn('GrokVoice', `Playback enqueue failed: ${(e as Error).message}`),
        );
      },
      onSpeechStarted: () => {
        // Barge-in: stop Grok's playback the moment the user talks.
        GrokAudio.interrupt();
        flushConversationEntry();
      },
      onError: (message) => {
        LogService.error('GrokVoice', `Realtime error: ${message}`);
        callbacks.onError?.(message);
      },
    });

    // 3) Open the WebSocket to x.ai.
    try {
      await _client.connect({
        ephemeralToken: session.ephemeral_token,
        wsUrl: session.ws_url,
        voice: settings.grokVoiceId || 'eve',
        instructions: buildInstructions(settings, profile),
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'No se pudo conectar con Grok.';
      setState('error');
      callbacks.onError?.(msg);
      return;
    }

    // 4) Native audio: start session (configures AVAudioSession for the glasses),
    //    then begin streaming mic frames up and playing response frames down.
    try {
      GrokAudio.startSession();
      // Captured mic frames → straight to the WS.
      _audioSubs.push(
        GrokAudio.addListener('onAudioData', (payload: { base64?: string }) => {
          if (payload?.base64) _client?.sendAudio(payload.base64);
        }),
      );
      _audioSubs.push(
        GrokAudio.addListener('onError', (payload: { message?: string }) => {
          const msg = payload?.message ?? 'Error de audio nativo.';
          LogService.error('GrokVoice', `Native audio error: ${msg}`);
          callbacks.onError?.(msg);
        }),
      );
      GrokAudio.startCapture();
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'No se pudo iniciar el micrófono.';
      LogService.error('GrokVoice', `Capture start failed: ${msg}`);
      setState('error');
      callbacks.onError?.(msg);
      await this.stopSession();
      return;
    }

    setState('listening');
    LogService.info('GrokVoice', '✅ Realtime session ready');
  },

  async stopSession(): Promise<void> {
    LogService.info('GrokVoice', `Stopping session (state=${_state.value})`);
    // Tear down in reverse order: stop capture → close WS → stop native session.
    try { GrokAudio.stopCapture(); } catch {}
    _audioSubs.forEach((s) => { try { s.remove(); } catch {} });
    _audioSubs = [];
    if (_client) {
      try { await _client.disconnect(); } catch {}
      _client = null;
    }
    try { GrokAudio.stopSession(); } catch {}
    flushConversationEntry();
    _currentCallbacks = null;
    setState('idle');
  },

  /** Manually interrupt Grok (e.g. user tapped stop). */
  interrupt(): void {
    try { GrokAudio.interrupt(); } catch {}
    _client?.interrupt();
    flushConversationEntry();
  },
};
