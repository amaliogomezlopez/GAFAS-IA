import { LLMService, STTService, TTSService } from './ai';
import { StreamingTtsPlayer } from './ai/StreamingTtsPlayer';
import { sanitizeForSpeech } from './ai/speechText';
import { AudioService } from './audio';
import { LogService } from './LogService';
import GrokAudio from '../../modules/grok-audio/src/GrokAudio';
import { Platform } from 'react-native';
import type { AppSettings, ConversationEntry, ConversationMessage, UserProfile } from '../types';
import { RESPONSE_STYLE_PRESETS } from '../constants';

type PipelineState = 'idle' | 'listening' | 'processing' | 'speaking';

type LatencyMetrics = { sttMs?: number; llmMs?: number; ttsMs?: number; totalMs?: number };

type PipelineCallback = {
  onStateChange: (state: PipelineState) => void;
  onTranscription: (text: string) => void;
  onInterimTranscription: (text: string) => void;
  onResponse: (text: string) => void;
  onError: (error: string) => void;
  onConversationEntry: (entry: ConversationEntry) => void;
  onLatencyUpdate?: (metrics: LatencyMetrics) => void;
  /** Previous turns of the active chat (oldest first) sent as LLM context. */
  getContextMessages?: () => ConversationMessage[];
};

type ListenOptions = {
  allowEmptyTranscript?: boolean;
  source?: 'manual' | 'wake' | 'followup';
};

type TurnResult = {
  responseText: string;
  /** Time to first token on streaming paths, full LLM time otherwise. */
  llmMs: number;
  /** Time to first audio on streaming paths, full TTS time otherwise. */
  ttsMs: number;
};

let currentCallbacks: PipelineCallback | null = null;
let currentSettings: AppSettings | null = null;
let currentUserProfile: UserProfile | null = null;
/** Single source of truth for pipeline state — replaces boolean flags */
let pipelineState: PipelineState = 'idle';
let currentListenOptions: ListenOptions = {};
let activeTurnId = 0;
/** Incremented whenever a listen attempt starts or is cancelled. */
let listenGeneration = 0;
let activeAbortController: AbortController | null = null;
let followUpTimer: ReturnType<typeof setTimeout> | null = null;

/** Short tail after TTS so iOS can settle audio routing before wake word resumes again */
const POST_TTS_BUFFER_MS = 90;
const FOLLOW_UP_RELISTEN_DELAY_MS = 140;
const WEB_SPEECH_HANDOFF_DELAY_MS = 320;
const IOS_SPEECH_HANDOFF_DELAY_MS = 650;
/** Previous turns sent as context. Keeps prompts small for the voice use case. */
const MAX_CONTEXT_TURNS = 6;
const TIMEOUT_MESSAGE = 'El modelo tardó demasiado. Prueba un modo más rápido o revisa la conexión.';
const EMPTY_RESPONSE_MESSAGE = 'El modelo no devolvió texto. Revisa el modelo seleccionado o el límite de tokens.';

/** Read through a function so TS doesn't narrow the module state across awaits. */
function getPipelineState(): PipelineState {
  return pipelineState;
}

function setState(state: PipelineState): void {
  pipelineState = state;
  currentCallbacks?.onStateChange(state);
}

function buildSystemPrompt(settings: AppSettings, profile: UserProfile | null): string {
  let prompt = settings.systemPrompt;

  const responseInstructionMap = {
    // Ultra-short forced replies are the single biggest latency+cost lever
    // (cf. hypercheap-voiceAI): the first sentence reaches TTS within a few
    // tokens, output stays tiny, and TTS has fewer chars to synthesize.
    instant: '\nResponde en una sola frase corta, máximo 15 palabras. Nunca uses emojis. Ve directo al grano.',
    balanced: '\nResponde de forma breve, clara y conversacional, en una o dos frases. Evita rodeos innecesarios.',
    natural: '\nResponde con tono natural y fluido, en dos o tres frases como mucho salvo que el usuario pida detalle.',
  } as const;

  if (settings.responseStyle) {
    prompt += responseInstructionMap[settings.responseStyle];
  }
  prompt += '\nTu respuesta se leerá en voz alta: no uses Markdown, listas, tablas, emojis ni URLs.';
  if (settings.wakeWord) {
    prompt += `\nNo pronuncies la palabra de activación "${settings.wakeWord}" salvo que el usuario te pregunte literalmente por ella.`;
  }

  if (!profile || !profile.name) return prompt;

  let extra = `\nEl usuario se llama ${profile.name}. Llámale por su nombre de forma natural.`;
  if (profile.birthday) {
    extra += ` Su cumpleaños es el ${profile.birthday}.`;
  }
  return prompt + extra;
}

function getRuntimeMaxTokens(settings: AppSettings): number {
  return RESPONSE_STYLE_PRESETS.find((preset) => preset.id === settings.responseStyle)?.maxTokens ?? 320;
}

/**
 * Builds the message list for the LLM. Hermes keeps its own server-side
 * session (X-Hermes-Session-Key), so it only receives the new message.
 */
function buildMessages(userMessage: ConversationMessage, settings: AppSettings): ConversationMessage[] {
  if (settings.llmProvider === 'hermes') return [userMessage];
  const history = (currentCallbacks?.getContextMessages?.() ?? [])
    .filter((message) => message.content.trim())
    .slice(-MAX_CONTEXT_TURNS * 2);
  return [...history, userMessage];
}

function makeMessage(role: 'user' | 'assistant', content: string): ConversationMessage {
  const timestamp = Date.now();
  return { id: `msg_${timestamp}_${role}_${Math.random().toString(36).slice(2, 6)}`, role, content, timestamp };
}

/**
 * Low-latency voice path (OpenCode/Hermes + Kokoro streaming PCM + native ring
 * buffer). Overlaps LLM generation, TTS synthesis and playback so end-of-speech
 * to first audio is minimized. Instruments first-token and first-audio timings.
 */
async function generateAndSpeakLowLatency(
  userMessage: ConversationMessage,
  settings: AppSettings,
  controller: AbortController,
): Promise<TurnResult> {
  const turnStart = Date.now();
  let firstTokenMs: number | null = null;
  let firstAudioMs: number | null = null;
  let streamedText = '';

  // Prepare the native player once for the whole turn: configures the
  // AVAudioSession (Bluetooth routing for the glasses) and the ring buffer.
  try {
    GrokAudio.startPlaybackSession();
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    LogService.warn('Pipeline', `Native playback session unavailable: ${msg}`);
  }

  const player = new StreamingTtsPlayer({
    voice: settings.ttsVoice,
    speed: settings.ttsRate,
    signal: controller.signal,
    onFirstAudio: () => {
      firstAudioMs = Date.now() - turnStart;
      LogService.info('Pipeline', `[latency] first_audio=${firstAudioMs}ms`);
      if (pipelineState === 'processing') setState('speaking');
    },
  });

  const teardown = () => {
    try { player.stop(); } catch {}
    try { GrokAudio.stopPlaybackSession(); } catch {}
  };

  const llmStart = Date.now();
  let streamResult: { text: string; streamed: boolean };
  try {
    streamResult = await LLMService.chatStream(
      buildMessages(userMessage, settings),
      buildSystemPrompt(settings, currentUserProfile),
      settings.llmProvider,
      settings.llmModel,
      {
        maxTokens: getRuntimeMaxTokens(settings),
        signal: controller.signal,
        onDelta: (delta, fullText) => {
          if (firstTokenMs === null) {
            firstTokenMs = Date.now() - turnStart;
            LogService.info('Pipeline', `[latency] first_token=${firstTokenMs}ms`);
          }
          streamedText = fullText;
          currentCallbacks?.onResponse(fullText);
          // Each delta is handed to the player, which splits sentences and kicks
          // off a Kokoro streaming request per sentence → PCM into the ring buffer.
          player.pushText(delta);
        },
      },
    );
  } catch (error) {
    teardown();
    throw error;
  }

  const llmMs = Date.now() - llmStart;
  const responseText = (streamResult.text || streamedText).trim();
  if (!responseText) {
    teardown();
    throw new Error(EMPTY_RESPONSE_MESSAGE);
  }
  // Non-streamed fallback (e.g. proxy returned a full JSON body): speak it all.
  if (!streamResult.streamed) player.pushText(responseText);

  currentCallbacks?.onResponse(responseText);
  LogService.info('Pipeline', `LLM response (${llmMs}ms): "${responseText.substring(0, 100)}"`);

  // Flush the tail sentence and wait until the native player has drained.
  const ttsStart = Date.now();
  try {
    await player.finish();
  } catch (ttsError) {
    const ttsMsg = ttsError instanceof Error ? ttsError.message : String(ttsError);
    LogService.warn('Pipeline', `Low-latency TTS failed: ${ttsMsg}`);
  }

  LogService.info(
    'Pipeline',
    `[latency] summary first_token=${firstTokenMs}ms first_audio=${firstAudioMs}ms total=${Date.now() - turnStart}ms`,
  );

  // Tear down the native player session so the pipeline's idle audio routing
  // takes over again (wake-word / next STT pass).
  try { GrokAudio.stopPlaybackSession(); } catch {}

  // Kokoro unreachable (server down, TTS disabled, rate limited…): answer with
  // the on-device voice instead of leaving the user in silence.
  if (!player.hasPlayedAudio && !controller.signal.aborted) {
    LogService.warn('Pipeline', 'Kokoro produced no audio — falling back to native TTS');
    if (pipelineState === 'processing') setState('speaking');
    try {
      await TTSService.synthesize(responseText, 'native', 'native-ios', {
        language: 'es-ES',
        rate: settings.ttsRate,
        pitch: settings.ttsPitch,
        nativeVoiceId: settings.ttsNativeVoiceId,
        signal: controller.signal,
      });
    } catch (fallbackError) {
      LogService.warn('Pipeline', `Native TTS fallback failed: ${String(fallbackError)}`);
    }
  }

  return {
    responseText,
    llmMs: firstTokenMs ?? llmMs,
    ttsMs: firstAudioMs !== null ? Math.max(0, firstAudioMs - (firstTokenMs ?? 0)) : Date.now() - ttsStart,
  };
}

async function generateAndSpeak(
  userMessage: ConversationMessage,
  settings: AppSettings,
  controller: AbortController,
): Promise<TurnResult> {
  const canStream = settings.streamingEnabled && (settings.llmProvider === 'hermes' || settings.llmProvider === 'opencode');
  const canChunkTTS = canStream && settings.ttsChunkedPlaybackEnabled;

  // Low-latency path: Kokoro streaming PCM into the native ring buffer. This
  // overlaps LLM generation, TTS synthesis and playback (hypercheap-voiceAI
  // pattern). Falls back to the chunked-blob speaker when the native module
  // isn't available (Expo Go / Android).
  if (canStream && settings.ttsProvider === 'kokoro' && GrokAudio.isAvailable) {
    return generateAndSpeakLowLatency(userMessage, settings, controller);
  }

  let streamedAny = false;
  let streamedText = '';

  const speaker = canChunkTTS
    ? TTSService.createStreamingSpeaker(settings.ttsProvider, settings.ttsVoice, {
        language: settings.ttsLanguage,
        rate: settings.ttsRate,
        pitch: settings.ttsPitch,
        nativeVoiceId: settings.ttsNativeVoiceId,
        signal: controller.signal,
        onChunkStart: () => {
          if (pipelineState === 'processing') setState('speaking');
        },
      })
    : null;

  const llmStart = Date.now();
  const messages = buildMessages(userMessage, settings);
  const systemPrompt = buildSystemPrompt(settings, currentUserProfile);
  let llmText = '';

  try {
    if (canStream) {
      const streamResult = await LLMService.chatStream(
        messages,
        systemPrompt,
        settings.llmProvider,
        settings.llmModel,
        {
          maxTokens: getRuntimeMaxTokens(settings),
          signal: controller.signal,
          onDelta: (delta, fullText) => {
            streamedAny = true;
            streamedText = fullText;
            currentCallbacks?.onResponse(fullText);
            speaker?.pushText(delta);
          },
        },
      );
      llmText = streamResult.text || streamedText;
      streamedAny = streamedAny || streamResult.streamed;
    } else {
      llmText = await LLMService.chat(
        messages,
        systemPrompt,
        settings.llmProvider,
        settings.llmModel,
        { maxTokens: getRuntimeMaxTokens(settings), signal: controller.signal },
      );
    }
  } catch (error) {
    speaker?.stop();
    throw error;
  }

  const llmMs = Date.now() - llmStart;
  const responseText = (llmText || streamedText).trim();
  if (!responseText) {
    speaker?.stop();
    throw new Error(EMPTY_RESPONSE_MESSAGE);
  }

  currentCallbacks?.onResponse(responseText);
  LogService.info('Pipeline', `LLM response (${llmMs}ms): "${responseText.substring(0, 100)}"`);

  const ttsStart = Date.now();
  try {
    if (speaker && streamedAny) {
      await speaker.finish();
    } else {
      speaker?.stop();
      if (pipelineState === 'processing') setState('speaking');
      await TTSService.synthesize(
        sanitizeForSpeech(responseText),
        settings.ttsProvider,
        settings.ttsVoice,
        {
          language: settings.ttsLanguage,
          rate: settings.ttsRate,
          pitch: settings.ttsPitch,
          nativeVoiceId: settings.ttsNativeVoiceId,
          signal: controller.signal,
        },
      );
    }
  } catch (ttsError) {
    const ttsMsg = ttsError instanceof Error ? ttsError.message : String(ttsError);
    LogService.warn('Pipeline', `TTS failed: ${ttsMsg}`);
  }

  return { responseText, llmMs, ttsMs: Date.now() - ttsStart };
}

function createTurnController(timeoutMs: number): { turnId: number; controller: AbortController; cleanup: () => void } {
  activeTurnId += 1;
  activeAbortController?.abort();
  const controller = new AbortController();
  activeAbortController = controller;
  const limitMs = Math.max(2500, timeoutMs);
  // The timeout guards against a model that never answers. If audio is already
  // playing when it fires, grant one extension instead of cutting the
  // assistant mid-sentence; a stream that stalls after that is still aborted.
  const arm = (extended: boolean): ReturnType<typeof setTimeout> => setTimeout(() => {
    if (pipelineState === 'speaking' && !extended) {
      timeout = arm(true);
      return;
    }
    (controller as AbortController & { timedOut?: boolean }).timedOut = true;
    controller.abort();
  }, limitMs);
  let timeout = arm(false);
  return {
    turnId: activeTurnId,
    controller,
    cleanup: () => {
      clearTimeout(timeout);
      if (activeAbortController === controller) {
        activeAbortController = null;
      }
    },
  };
}

function isTurnCurrent(turnId: number, controller: AbortController): boolean {
  return activeTurnId === turnId && !controller.signal.aborted;
}

function didTurnTimeOut(controller: AbortController): boolean {
  return Boolean((controller as AbortController & { timedOut?: boolean }).timedOut);
}

function clearFollowUpTimer(): void {
  if (followUpTimer) {
    clearTimeout(followUpTimer);
    followUpTimer = null;
  }
}

function describeError(error: unknown): string {
  const message = error instanceof Error ? error.message : 'Error desconocido';
  if (/network request failed|failed to fetch|load failed/i.test(message)) {
    return 'Sin conexión con el servidor. Revisa tu conexión a internet o el proxy.';
  }
  return message;
}

export const PipelineOrchestrator = {
  registerCallbacks(callbacks: PipelineCallback): void {
    currentCallbacks = callbacks;
  },

  async startListening(settings: AppSettings, userProfile?: UserProfile, options: ListenOptions = {}): Promise<void> {
    if (pipelineState !== 'idle') {
      LogService.warn('Pipeline', `Cannot start listening — current state: ${pipelineState}`);
      return;
    }

    clearFollowUpTimer();
    listenGeneration += 1;
    const generation = listenGeneration;
    setState('listening');
    currentSettings = settings;
    currentUserProfile = userProfile ?? null;
    currentListenOptions = options;

    try {
      LogService.info('Pipeline', `Starting speech recognition (${options.source ?? 'manual'})...`);
      if (Platform.OS === 'web') {
        await new Promise((resolve) => setTimeout(resolve, WEB_SPEECH_HANDOFF_DELAY_MS));
      } else if (Platform.OS === 'ios') {
        await new Promise((resolve) => setTimeout(resolve, IOS_SPEECH_HANDOFF_DELAY_MS));
      }
      // The user may have cancelled (or force-stopped) during the handoff delay.
      if (generation !== listenGeneration || getPipelineState() !== 'listening') {
        LogService.debug('Pipeline', 'Listen cancelled during audio handoff');
        return;
      }
      await STTService.startListening({
        language: 'es',
        silenceTimeoutMs: settings.silenceThresholdMs,
        finalSilenceTimeoutMs: settings.finalSilenceThresholdMs,
        retryDelayMs: settings.sttRetryDelayMs,
        stopTimeoutMs: settings.sttStopTimeoutMs,
        maxListeningDurationMs: settings.maxRecordingDurationMs,
        persistAudio: settings.speechDebugAudioEnabled,
        diagnosticLabel: `stt_${options.source ?? 'manual'}`,
        onSilenceDetected: () => {
          LogService.info('Pipeline', 'Silence detected — auto-stopping and processing...');
          PipelineOrchestrator.stopListeningAndProcess();
        },
        onInterim: (interimText: string) => {
          currentCallbacks?.onInterimTranscription(interimText);
        },
      });
      if (generation !== listenGeneration) {
        // Cancelled while the recognizer was starting.
        STTService.cancel();
        return;
      }
      LogService.info('Pipeline', 'Speech recognition started - listening');
    } catch (error) {
      if (generation !== listenGeneration) return;
      const message = error instanceof Error ? error.message : 'Error al iniciar reconocimiento de voz';
      LogService.error('Pipeline', `startListening failed: ${message}`);
      currentCallbacks?.onError(message);
      setState('idle');
    }
  },

  async stopListeningAndProcess(): Promise<void> {
    if (pipelineState !== 'listening') {
      LogService.warn('Pipeline', `Cannot process — current state: ${pipelineState}`);
      return;
    }
    if (!currentSettings) {
      setState('idle');
      return;
    }

    const settings = currentSettings;
    setState('processing');
    const totalStart = Date.now();
    const listenOptions = currentListenOptions;
    const generation = listenGeneration;
    const sttStart = Date.now();
    const transcription = (await STTService.stopAndGetTranscript()).trim();
    const sttMs = Date.now() - sttStart;
    // Force-stopped while the recognizer was finalizing.
    if (generation !== listenGeneration || getPipelineState() !== 'processing') return;

    if (!transcription) {
      if (getPipelineState() === 'processing') setState('idle');
      if (listenOptions.allowEmptyTranscript) {
        LogService.info('Pipeline', 'Follow-up listen ended with no speech');
        return;
      }
      const mic = STTService.getLastMicDiagnostics();
      let message = 'No te he oído. Pulsa y habla de nuevo.';
      if (Platform.OS === 'web' && mic) {
        message = mic.maxRms < 0.006 && mic.maxPeak < 0.04
          ? 'Chrome no está recibiendo audio del micrófono. Selecciona el micro de las gafas en Chrome o en Entrada de sonido de macOS y prueba otra vez.'
          : 'Chrome recibe señal de audio, pero el reconocimiento web no está devolviendo texto. Prueba una frase más larga en español o usa la app iOS para reconocimiento Bluetooth fiable.';
      }
      LogService.warn('Pipeline', `Empty transcript: ${message}`);
      currentCallbacks?.onError(message);
      return;
    }

    LogService.info('Pipeline', `Transcription (${sttMs}ms): "${transcription}"`);
    await this.runTurn(transcription, settings, { sttMs, totalStart });
  },

  async sendTextMessage(text: string, settings: AppSettings, userProfile?: UserProfile): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed) return;
    if (pipelineState !== 'idle') {
      LogService.warn('Pipeline', `Text message ignored — current state: ${pipelineState}`);
      return;
    }

    clearFollowUpTimer();
    setState('processing');
    currentSettings = settings;
    currentUserProfile = userProfile ?? null;
    LogService.info('Pipeline', `Text message: "${trimmed}"`);
    await this.runTurn(trimmed, settings, { sttMs: 0, totalStart: Date.now() });
  },

  /** Shared LLM → TTS → history part of a turn. Expects state 'processing'. */
  async runTurn(
    text: string,
    settings: AppSettings,
    timing: { sttMs: number; totalStart: number },
  ): Promise<void> {
    const { turnId, controller, cleanup } = createTurnController(settings.llmRequestTimeoutMs);
    let shouldStartFollowUp = false;

    try {
      currentCallbacks?.onTranscription(text);
      const userMessage = makeMessage('user', text);

      LogService.info('Pipeline', `Sending to LLM (${settings.llmProvider}/${settings.llmModel})...`);
      const { responseText, llmMs, ttsMs } = await generateAndSpeak(userMessage, settings, controller);
      if (!isTurnCurrent(turnId, controller)) return;

      const totalMs = Date.now() - timing.totalStart;
      LogService.info('Pipeline', `✅ Pipeline complete — STT:${timing.sttMs}ms LLM:${llmMs}ms TTS:${ttsMs}ms Total:${totalMs}ms`);
      currentCallbacks?.onLatencyUpdate?.({ sttMs: timing.sttMs, llmMs, ttsMs, totalMs });

      const entry: ConversationEntry = {
        id: `entry_${Date.now()}_${turnId}`,
        userMessage,
        assistantMessage: makeMessage('assistant', responseText),
        profileId: settings.selectedProfileId,
        createdAt: Date.now(),
      };
      currentCallbacks?.onConversationEntry(entry);
      shouldStartFollowUp = Platform.OS !== 'web' && Boolean(settings.continuousConversation);

      // Post-TTS buffer: wait before going idle to ensure BLE audio has finished
      if (pipelineState === 'speaking') {
        await new Promise((r) => setTimeout(r, POST_TTS_BUFFER_MS));
      }
    } catch (error) {
      if (controller.signal.aborted) {
        if (didTurnTimeOut(controller)) {
          LogService.warn('Pipeline', TIMEOUT_MESSAGE);
          currentCallbacks?.onError(TIMEOUT_MESSAGE);
        } else {
          LogService.warn('Pipeline', 'Turn aborted');
        }
        return;
      }
      const message = describeError(error);
      LogService.error('Pipeline', `Turn failed: ${message}`);
      currentCallbacks?.onError(message);
    } finally {
      cleanup();
      // A newer turn (interrupt → listen) may already own the state machine.
      if (activeTurnId === turnId) {
        if (pipelineState !== 'idle') setState('idle');
        if (shouldStartFollowUp) {
          const profile = currentUserProfile ?? undefined;
          followUpTimer = setTimeout(() => {
            followUpTimer = null;
            PipelineOrchestrator.startListening(settings, profile, { allowEmptyTranscript: true, source: 'followup' });
          }, FOLLOW_UP_RELISTEN_DELAY_MS);
        }
      }
    }
  },

  /** Force-stop everything immediately — kills STT, TTS, resets to idle */
  async forceStop(): Promise<void> {
    LogService.warn('Pipeline', `⛔ Force stop from state: ${pipelineState}`);
    clearFollowUpTimer();
    activeTurnId += 1;
    listenGeneration += 1;
    activeAbortController?.abort();
    activeAbortController = null;
    try { STTService.cancel(); } catch {}
    try { await AudioService.stopPlayback(); } catch {}
    // Also clear the native low-latency ring buffer so any Kokoro PCM in flight
    // is dropped immediately (instant barge-in on the streaming-TTS path).
    if (GrokAudio.isAvailable) {
      try { GrokAudio.clearPlayback(); } catch {}
      try { GrokAudio.stopPlaybackSession(); } catch {}
    }
    try {
      const Speech = require('expo-speech');
      Speech.stop();
    } catch {}
    setState('idle');
  },

  async interruptAndListen(settings: AppSettings, userProfile?: UserProfile): Promise<void> {
    await this.forceStop();
    await new Promise((resolve) => setTimeout(resolve, 80));
    await this.startListening(settings, userProfile, { source: 'manual' });
  },

  async cancelListening(): Promise<void> {
    clearFollowUpTimer();
    if (pipelineState === 'listening') {
      listenGeneration += 1;
      STTService.cancel();
      setState('idle');
    }
  },

  isActive(): boolean {
    return pipelineState !== 'idle';
  },

  isCurrentlyListening(): boolean {
    return pipelineState === 'listening';
  },

  getState(): PipelineState {
    return pipelineState;
  },
};
