import { LLMService, STTService, TTSService } from './ai';
import { StreamingTtsPlayer } from './ai/StreamingTtsPlayer';
import { AudioService } from './audio';
import { LogService } from './LogService';
import GrokAudio from '../../modules/grok-audio/src/GrokAudio';
import { Platform } from 'react-native';
import type { AppSettings, ConversationEntry, ConversationMessage, UserProfile } from '../types';
import { RESPONSE_STYLE_PRESETS } from '../constants';

type PipelineState = 'idle' | 'listening' | 'processing' | 'speaking';

type PipelineCallback = {
  onStateChange: (state: PipelineState) => void;
  onTranscription: (text: string) => void;
  onInterimTranscription: (text: string) => void;
  onResponse: (text: string) => void;
  onError: (error: string) => void;
  onConversationEntry: (entry: ConversationEntry) => void;
  onLatencyUpdate?: (metrics: { sttMs?: number; llmMs?: number; ttsMs?: number; totalMs?: number }) => void;
};

type ListenOptions = {
  allowEmptyTranscript?: boolean;
  source?: 'manual' | 'wake' | 'followup';
};

let currentCallbacks: PipelineCallback | null = null;
let currentSettings: AppSettings | null = null;
let currentUserProfile: UserProfile | null = null;
/** Single source of truth for pipeline state — replaces boolean flags */
let pipelineState: PipelineState = 'idle';
let currentListenOptions: ListenOptions = {};
let activeTurnId = 0;
let activeAbortController: AbortController | null = null;
let followUpTimer: ReturnType<typeof setTimeout> | null = null;

/** Short tail after TTS so iOS can settle audio routing before wake word resumes again */
const POST_TTS_BUFFER_MS = 90;
const FOLLOW_UP_RELISTEN_DELAY_MS = 140;
const WEB_SPEECH_HANDOFF_DELAY_MS = 320;
const IOS_SPEECH_HANDOFF_DELAY_MS = 650;

/** Sanitize text for natural TTS pronunciation */
function sanitizeForTTS(text: string): string {
  return text
    .replace(/K\.A\.I\.R\.O\./gi, 'KAIRO')
    .replace(/K\.A\.I\.R\.O/gi, 'KAIRO');
}

function setState(state: PipelineState): void {
  pipelineState = state;
  currentCallbacks?.onStateChange(state);
}

function buildSystemPrompt(basePrompt: string, profile: UserProfile | null): string {
  let prompt = basePrompt;

  const responseInstructionMap = {
    // Ultra-short forced replies are the single biggest latency+cost lever
    // (cf. hypercheap-voiceAI): the first sentence reaches TTS within a few
    // tokens, output stays tiny, and TTS has fewer chars to synthesize.
    instant: '\nResponde en una sola frase corta, máximo 15 palabras. Nunca uses emojis. Ve directo al grano.',
    balanced: '\nResponde de forma breve, clara y conversacional, en una o dos frases. Evita rodeos innecesarios.',
    natural: '\nResponde con tono natural y fluido, en dos o tres frases como mucho salvo que el usuario pida detalle.',
  } as const;

  if (currentSettings?.responseStyle) {
    prompt += responseInstructionMap[currentSettings.responseStyle];
  }
  if (currentSettings?.wakeWord) {
    prompt += `\nNo pronuncies la palabra de activación "${currentSettings.wakeWord}" salvo que el usuario te pregunte literalmente por ella.`;
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
 * Low-latency voice path (OpenCode/Hermes + Kokoro streaming PCM + native ring
 * buffer). Overlaps LLM generation, TTS synthesis and playback so end-of-speech
 * to first audio is minimized. Instruments first-token and first-audio timings.
 */
async function generateAndSpeakLowLatency(
  userMessage: ConversationMessage,
  settings: AppSettings,
  controller: AbortController,
): Promise<{ responseText: string; llmMs: number; ttsMs: number }> {
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
    LogService.warn('Pipeline', `Native playback session unavailable, falling back: ${msg}`);
    // Fallback: non-low-latency path below keeps the app working.
  }

  const player = new StreamingTtsPlayer({
    voice: settings.ttsVoice,
    speed: settings.ttsRate,
    signal: controller.signal,
    onFirstAudio: () => {
      firstAudioMs = Date.now() - turnStart;
      LogService.info('Pipeline', `[latency] first_audio=${firstAudioMs}ms`);
      if (pipelineState === 'processing') {
        setState('speaking');
      }
    },
    onChunkStart: () => {
      if (pipelineState === 'processing') {
        setState('speaking');
      }
    },
  });

  const llmStart = Date.now();
  const streamResult = await LLMService.chatStream(
    [userMessage],
    buildSystemPrompt(settings.systemPrompt, currentUserProfile),
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
  ).catch((error) => {
    // On any failure (incl. abort), make sure we tear down native playback.
    try { player.stop(); } catch {}
    try { GrokAudio.stopPlaybackSession(); } catch {}
    throw error;
  });

  const llmMs = Date.now() - llmStart;
  const responseText = (streamResult.text || streamedText).trim();
  if (!responseText) {
    try { player.stop(); } catch {}
    try { GrokAudio.stopPlaybackSession(); } catch {}
    throw new Error('El modelo no devolvió texto. Revisa el modelo seleccionado o el límite de tokens.');
  }

  currentCallbacks?.onResponse(responseText);
  LogService.info('Pipeline', `LLM response (${llmMs}ms): "${responseText.substring(0, 100)}"`);

  // Flush the tail sentence and wait for all queued Kokoro segments to finish
  // playing. This is where the turn "ends" from the user's perspective.
  const ttsStart = Date.now();
  try {
    await player.finish();
  } catch (ttsError) {
    const ttsMsg = ttsError instanceof Error ? ttsError.message : String(ttsError);
    LogService.warn('Pipeline', `Low-latency TTS failed: ${ttsMsg}`);
  }

  const totalToFirstAudio = firstAudioMs;
  const totalTurnMs = Date.now() - turnStart;
  LogService.info(
    'Pipeline',
    `[latency] summary first_token=${firstTokenMs}ms first_audio=${firstAudioMs}ms total=${totalTurnMs}ms`,
  );
  currentCallbacks?.onLatencyUpdate?.({
    sttMs: 0,
    llmMs: firstTokenMs ?? llmMs,
    ttsMs: totalToFirstAudio ?? Date.now() - ttsStart,
    totalMs: totalTurnMs,
  });

  // Tear down the native player session so the pipeline's idle audio routing
  // takes over again (wake-word / next STT pass).
  try { GrokAudio.stopPlaybackSession(); } catch {}

  return { responseText, llmMs, ttsMs: Date.now() - ttsStart };
}

async function generateAndSpeak(
  userMessage: ConversationMessage,
  settings: AppSettings,
  controller: AbortController,
): Promise<{ responseText: string; llmMs: number; ttsMs: number }> {
  const canStream = settings.streamingEnabled && (settings.llmProvider === 'hermes' || settings.llmProvider === 'opencode');
  const canChunkTTS = canStream && settings.ttsChunkedPlaybackEnabled;

  // Low-latency path: Kokoro streaming PCM into the native ring buffer. This
  // overlaps LLM generation, TTS synthesis and playback (hypercheap-voiceAI
  // pattern). Falls back to the chunked-blob speaker when the native module
  // isn't available (Expo Go / Android).
  const useLowLatencyKokoro =
    canStream && settings.ttsProvider === 'kokoro' && GrokAudio.isAvailable;

  if (useLowLatencyKokoro) {
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
          if (pipelineState === 'processing') {
            setState('speaking');
          }
        },
      })
    : null;

  const llmStart = Date.now();
  let llmText = '';

  if (canStream) {
    const streamResult = await LLMService.chatStream(
      [userMessage],
      buildSystemPrompt(settings.systemPrompt, currentUserProfile),
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
      [userMessage],
      buildSystemPrompt(settings.systemPrompt, currentUserProfile),
      settings.llmProvider,
      settings.llmModel,
      { maxTokens: getRuntimeMaxTokens(settings), signal: controller.signal },
    );
  }

  const llmMs = Date.now() - llmStart;
  const responseText = (llmText || streamedText).trim();
  if (!responseText) {
    throw new Error('El modelo no devolvió texto. Revisa el modelo seleccionado o el límite de tokens.');
  }

  currentCallbacks?.onResponse(responseText);
  LogService.info('Pipeline', `LLM response (${llmMs}ms): "${responseText.substring(0, 100)}"`);

  const ttsStart = Date.now();
  try {
    if (speaker && streamedAny) {
      await speaker.finish();
    } else {
      if (pipelineState === 'processing') {
        setState('speaking');
      }
      await TTSService.synthesize(
        sanitizeForTTS(responseText),
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
  const timeout = setTimeout(() => {
    (controller as AbortController & { timedOut?: boolean }).timedOut = true;
    controller.abort();
  }, Math.max(2500, timeoutMs));
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

function isTurnCurrent(turnId: number): boolean {
  return activeTurnId === turnId && !activeAbortController?.signal.aborted;
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
      await STTService.startListening({
        language: 'es',
        silenceTimeoutMs: currentSettings.silenceThresholdMs,
        finalSilenceTimeoutMs: currentSettings.finalSilenceThresholdMs,
        retryDelayMs: currentSettings.sttRetryDelayMs,
        stopTimeoutMs: currentSettings.sttStopTimeoutMs,
        maxListeningDurationMs: currentSettings.maxRecordingDurationMs,
        persistAudio: currentSettings.speechDebugAudioEnabled,
        diagnosticLabel: `stt_${options.source ?? 'manual'}`,
        onSilenceDetected: () => {
          // Auto-stop after silence detected
          LogService.info('Pipeline', 'Silence detected — auto-stopping and processing...');
          this.stopListeningAndProcess();
        },
        onInterim: (interimText: string) => {
          // Real-time interim transcription for UI
          currentCallbacks?.onInterimTranscription(interimText);
        },
      });
      LogService.info('Pipeline', 'Speech recognition started - listening');
    } catch (error) {
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

    setState('processing');
    const totalStart = Date.now();
    const listenOptions = currentListenOptions;
    const { turnId, controller, cleanup } = createTurnController(currentSettings?.llmRequestTimeoutMs ?? 12000);
    let shouldStartFollowUp = false;

    try {
      LogService.info('Pipeline', 'Stopping STT, waiting for transcript...');

      const sttStart = Date.now();
      const transcription = await STTService.stopAndGetTranscript();
      const sttMs = Date.now() - sttStart;

      if (!transcription.trim()) {
        if (listenOptions.allowEmptyTranscript) {
          LogService.info('Pipeline', 'Follow-up listen ended with no speech');
          return;
        }
        const mic = STTService.getLastMicDiagnostics();
        if (Platform.OS === 'web' && mic) {
          if (mic.maxRms < 0.006 && mic.maxPeak < 0.04) {
            throw new Error('Chrome no está recibiendo audio del micrófono. Selecciona el micro de las gafas en Chrome o en Entrada de sonido de macOS y prueba otra vez.');
          }
          throw new Error('Chrome recibe señal de audio, pero el reconocimiento web no está devolviendo texto. Prueba una frase más larga en español o usa la app iOS/dev-client para reconocimiento Bluetooth fiable.');
        }
        throw new Error('No se detectó voz. Intenta de nuevo.');
      }
      LogService.info('Pipeline', `Transcription (${sttMs}ms): "${transcription}"`);
      currentCallbacks?.onTranscription(transcription);

      if (!currentSettings) {
        throw new Error('Settings not available');
      }

      const userMessage: ConversationMessage = {
        id: `msg_${Date.now()}_user`,
        role: 'user',
        content: transcription,
        timestamp: Date.now(),
      };

      LogService.info('Pipeline', `Sending to LLM (${currentSettings.llmProvider}/${currentSettings.llmModel})...`);
      const { responseText, llmMs, ttsMs } = await generateAndSpeak(userMessage, currentSettings, controller);
      if (!isTurnCurrent(turnId)) return;
      const totalMs = Date.now() - totalStart;
      if (!isTurnCurrent(turnId)) return;

      LogService.info('Pipeline', `✅ Pipeline complete — STT:${sttMs}ms LLM:${llmMs}ms TTS:${ttsMs}ms Total:${totalMs}ms`);
      currentCallbacks?.onLatencyUpdate?.({ sttMs, llmMs, ttsMs, totalMs });

      const assistantMessage: ConversationMessage = {
        id: `msg_${Date.now()}_assistant`,
        role: 'assistant',
        content: responseText,
        timestamp: Date.now(),
      };

      const entry: ConversationEntry = {
        id: Date.now().toString(),
        userMessage,
        assistantMessage,
        profileId: currentSettings.selectedProfileId,
        createdAt: Date.now(),
      };
      currentCallbacks?.onConversationEntry(entry);
      shouldStartFollowUp = Platform.OS !== 'web' && Boolean(currentSettings.continuousConversation);

      // Post-TTS buffer: wait before going idle to ensure BLE audio has finished
      if (this.getState() === 'speaking') {
        await new Promise(r => setTimeout(r, POST_TTS_BUFFER_MS));
      }
    } catch (error) {
      if (controller.signal.aborted) {
        if (didTurnTimeOut(controller)) {
          const timeoutMsg = 'El modelo tardó demasiado. Prueba un modo más rápido o revisa la conexión.';
          LogService.warn('Pipeline', timeoutMsg);
          currentCallbacks?.onError(timeoutMsg);
        } else {
          LogService.warn('Pipeline', 'Turn aborted');
        }
        return;
      }
      const message = error instanceof Error ? error.message : 'Error desconocido';
      LogService.error('Pipeline', `stopListeningAndProcess failed: ${message}`);
      currentCallbacks?.onError(message);
    } finally {
      cleanup();
      if (this.getState() !== 'idle') {
        setState('idle');
      }
      if (shouldStartFollowUp && currentSettings && isTurnCurrent(turnId)) {
        const settings = currentSettings;
        const profile = currentUserProfile ?? undefined;
        followUpTimer = setTimeout(() => {
          this.startListening(settings, profile, { allowEmptyTranscript: true, source: 'followup' });
        }, FOLLOW_UP_RELISTEN_DELAY_MS);
      }
    }
  },

  async sendTextMessage(text: string, settings: AppSettings, userProfile?: UserProfile): Promise<void> {
    if (pipelineState !== 'idle') return;

    clearFollowUpTimer();
    setState('processing');
    currentSettings = settings;
    currentUserProfile = userProfile ?? null;
    const totalStart = Date.now();
    const { turnId, controller, cleanup } = createTurnController(settings.llmRequestTimeoutMs);
    let shouldStartFollowUp = false;

    try {
      currentCallbacks?.onTranscription(text);
      LogService.info('Pipeline', `Text message: "${text}"`);

      const userMessage: ConversationMessage = {
        id: `msg_${Date.now()}_user`,
        role: 'user',
        content: text,
        timestamp: Date.now(),
      };

      LogService.info('Pipeline', `Sending to LLM (${currentSettings.llmProvider}/${currentSettings.llmModel})...`);
      const { responseText, llmMs, ttsMs } = await generateAndSpeak(userMessage, currentSettings, controller);
      if (!isTurnCurrent(turnId)) return;
      const totalMs = Date.now() - totalStart;
      if (!isTurnCurrent(turnId)) return;
      currentCallbacks?.onLatencyUpdate?.({ sttMs: 0, llmMs, ttsMs, totalMs });

      const assistantMessage: ConversationMessage = {
        id: `msg_${Date.now()}_assistant`,
        role: 'assistant',
        content: responseText,
        timestamp: Date.now(),
      };

      const entry: ConversationEntry = {
        id: Date.now().toString(),
        userMessage,
        assistantMessage,
        profileId: currentSettings.selectedProfileId,
        createdAt: Date.now(),
      };
      currentCallbacks?.onConversationEntry(entry);
      shouldStartFollowUp = Platform.OS !== 'web' && Boolean(currentSettings.continuousConversation);

      if (this.getState() === 'speaking') {
        await new Promise(r => setTimeout(r, POST_TTS_BUFFER_MS));
      }
    } catch (error) {
      if (controller.signal.aborted) {
        if (didTurnTimeOut(controller)) {
          const timeoutMsg = 'El modelo tardó demasiado. Prueba un modo más rápido o revisa la conexión.';
          LogService.warn('Pipeline', timeoutMsg);
          currentCallbacks?.onError(timeoutMsg);
        } else {
          LogService.warn('Pipeline', 'Text turn aborted');
        }
        return;
      }
      const message = error instanceof Error ? error.message : 'Error desconocido';
      LogService.error('Pipeline', `sendTextMessage failed: ${message}`);
      currentCallbacks?.onError(message);
    } finally {
      cleanup();
      if (this.getState() !== 'idle') {
        setState('idle');
      }
      if (shouldStartFollowUp && currentSettings && isTurnCurrent(turnId)) {
        const activeSettings = currentSettings;
        const profile = currentUserProfile ?? undefined;
        followUpTimer = setTimeout(() => {
          this.startListening(activeSettings, profile, { allowEmptyTranscript: true, source: 'followup' });
        }, FOLLOW_UP_RELISTEN_DELAY_MS);
      }
    }
  },

  /** Force-stop everything immediately — kills STT, TTS, resets to idle */
  async forceStop(): Promise<void> {
    LogService.warn('Pipeline', `⛔ Force stop from state: ${pipelineState}`);
    clearFollowUpTimer();
    activeTurnId += 1;
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
    if (pipelineState === 'listening') {
      clearFollowUpTimer();
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
