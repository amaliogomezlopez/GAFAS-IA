/**
 * STTService — Native on-device Speech-to-Text
 *
 * Uses expo-speech-recognition (Apple Speech on iOS, Google on Android).
 * The main latency optimizations are:
 * - avoid fixed waits before start; retry only if the audio session is still busy
 * - use an aggressive final-result tail so processing starts almost immediately
 * - treat "aborted" as an expected state transition instead of a hard error
 */
import {
  AVAudioSessionCategory,
  AVAudioSessionCategoryOptions,
  AVAudioSessionMode,
  ExpoSpeechRecognitionModule,
} from 'expo-speech-recognition';
import { Platform } from 'react-native';
import type {
  ExpoSpeechRecognitionErrorEvent,
  ExpoSpeechRecognitionResultEvent,
} from 'expo-speech-recognition';
import { LogService } from '../LogService';
import { WebMicDiagnostics } from '../audio/WebMicDiagnostics';

type Subscription = { remove: () => void };

export interface STTStartOptions {
  language?: string;
  onSilenceDetected?: () => void;
  onInterim?: (text: string) => void;
  silenceTimeoutMs?: number;
  finalSilenceTimeoutMs?: number;
  retryDelayMs?: number;
  stopTimeoutMs?: number;
  maxListeningDurationMs?: number;
  persistAudio?: boolean;
  diagnosticLabel?: string;
}

const DEFAULT_SILENCE_TIMEOUT_MS = 1300;
const DEFAULT_FINAL_SILENCE_TIMEOUT_MS = 380;
const DEFAULT_RETRY_DELAY_MS = 120;
const DEFAULT_STOP_TIMEOUT_MS = 1500;
const WEB_INITIAL_SPEECH_TIMEOUT_MS = 6500;
const NATIVE_INITIAL_SPEECH_TIMEOUT_MS = 6500;
const WEB_RESTART_DELAY_MS = 160;
const NATIVE_RESTART_DELAY_MS = 220;

let interimTranscript = '';
let listeners: Subscription[] = [];
let silenceTimer: ReturnType<typeof setTimeout> | null = null;
let onSilenceCallback: (() => void) | null = null;
let onInterimCallback: ((text: string) => void) | null = null;
let silenceAlreadyFired = false;
let currentSilenceTimeoutMs = 1300;
let currentFinalSilenceTimeoutMs = 380;
let currentStopTimeoutMs = 1500;
let currentLang = 'es-ES';
let currentRetryDelayMs = DEFAULT_RETRY_DELAY_MS;
let isStopRequested = false;
let webNoSpeechRestartCount = 0;
let webInitialListenDeadlineAt = 0;
let initialListenDeadlineAt = 0;
let noSpeechRestartTimer: ReturnType<typeof setTimeout> | null = null;
let maxListenTimer: ReturnType<typeof setTimeout> | null = null;
let currentPersistAudio = false;
let currentDiagnosticLabel = 'speech';
let maxObservedVolume: number | null = null;
let lastVolumeLogAt = 0;
let lastAudioStartLogAt = 0;
let lastEngineStateLogAt = 0;

const ENGINE_STATE_LOG_INTERVAL_MS = 5000;
const ENGINE_STATE_LOG_TIMEOUT_MS = 700;

function canUseSpeechRecognitionOnThisPlatform(): boolean {
  if (Platform.OS !== 'web') return true;
  const globalObject = globalThis as typeof globalThis & {
    SpeechRecognition?: unknown;
    webkitSpeechRecognition?: unknown;
  };
  return Boolean(globalObject.SpeechRecognition || globalObject.webkitSpeechRecognition);
}

function isWebSpeechPlatform(): boolean {
  return Platform.OS === 'web';
}

const toLang = (lang: string): string => {
  if (lang.includes('-')) return lang;
  const map: Record<string, string> = {
    es: 'es-ES',
    en: 'en-US',
    fr: 'fr-FR',
    de: 'de-DE',
    it: 'it-IT',
    pt: 'pt-BR',
    zh: 'zh-CN',
    ja: 'ja-JP',
    ko: 'ko-KR',
  };
  return map[lang] || `${lang}-${lang.toUpperCase()}`;
};

function cleanup() {
  listeners.forEach((s) => {
    try {
      s.remove();
    } catch {}
  });
  listeners = [];
  if (silenceTimer) {
    clearTimeout(silenceTimer);
    silenceTimer = null;
  }
  if (maxListenTimer) {
    clearTimeout(maxListenTimer);
    maxListenTimer = null;
  }
  if (noSpeechRestartTimer) {
    clearTimeout(noSpeechRestartTimer);
    noSpeechRestartTimer = null;
  }
  onSilenceCallback = null;
  onInterimCallback = null;
  silenceAlreadyFired = false;
  isStopRequested = false;
  webNoSpeechRestartCount = 0;
  webInitialListenDeadlineAt = 0;
  initialListenDeadlineAt = 0;
  maxObservedVolume = null;
  lastVolumeLogAt = 0;
  lastAudioStartLogAt = 0;
}

async function stopWebMicDiagnostics(): Promise<void> {
  if (isWebSpeechPlatform()) {
    await WebMicDiagnostics.stop();
  }
}

function fireSilence() {
  if (silenceAlreadyFired) return;
  silenceAlreadyFired = true;
  if (onSilenceCallback) {
    const cb = onSilenceCallback;
    onSilenceCallback = null;
    cb();
  }
}

function resetSilenceTimer(isFinal: boolean = false, overrideTimeoutMs?: number) {
  if (silenceTimer) clearTimeout(silenceTimer);
  if (silenceAlreadyFired) return;

  const timeoutMs = overrideTimeoutMs ?? (
    isFinal
      ? Math.min(currentFinalSilenceTimeoutMs, currentSilenceTimeoutMs)
      : currentSilenceTimeoutMs
  );

  silenceTimer = setTimeout(() => {
    LogService.debug(
      'STT',
      `Silence timer fired (${timeoutMs}ms). Transcript: "${interimTranscript.substring(0, 60)}"`,
    );
    fireSilence();
  }, timeoutMs);
}

function isAbortEvent(event: ExpoSpeechRecognitionErrorEvent): boolean {
  const raw = `${event.error || ''} ${event.message || ''}`.toLowerCase();
  return raw.includes('abort');
}

function isNoSpeechEvent(event: ExpoSpeechRecognitionErrorEvent): boolean {
  const raw = `${event.error || ''} ${event.message || ''}`.toLowerCase();
  return raw.includes('no-speech') || raw.includes('no_speech') || raw.includes('speech-timeout');
}

function shouldRestartBeforeInitialSpeechDeadline(): boolean {
  return !isStopRequested && !silenceAlreadyFired && !interimTranscript.trim() && Date.now() < initialListenDeadlineAt;
}

function restartRecognitionAfterNoSpeech(reason: string): boolean {
  if (!shouldRestartBeforeInitialSpeechDeadline()) return false;
  if (noSpeechRestartTimer) {
    LogService.debug('STT', `${reason}; restart already pending`);
    return true;
  }
  const delayMs = isWebSpeechPlatform() ? WEB_RESTART_DELAY_MS : NATIVE_RESTART_DELAY_MS;
  webNoSpeechRestartCount += 1;
  LogService.debug('STT', `${reason}; restarting before initial deadline (${webNoSpeechRestartCount})`);
  noSpeechRestartTimer = setTimeout(() => {
    noSpeechRestartTimer = null;
    if (!shouldRestartBeforeInitialSpeechDeadline()) return;
    startRecognitionWithRetry(currentLang, currentRetryDelayMs).catch((error) => {
      LogService.warn('STT', `Speech restart failed: ${error}`);
      fireSilence();
    });
  }, delayMs);
  return true;
}

function buildRecognitionOptions(lang: string) {
  const iosCategory = Platform.OS === 'ios'
    ? {
        category: AVAudioSessionCategory.playAndRecord,
        categoryOptions: [
          AVAudioSessionCategoryOptions.allowBluetooth,
          AVAudioSessionCategoryOptions.allowBluetoothA2DP,
          AVAudioSessionCategoryOptions.allowAirPlay,
        ],
        mode: AVAudioSessionMode.default,
      }
    : undefined;

  const recordingOptions = currentPersistAudio && Platform.OS === 'web'
    ? {
        persist: true,
        outputFileName: `${currentDiagnosticLabel}_${Date.now()}.wav`,
      }
    : undefined;

  return {
    lang,
    interimResults: true,
    continuous: true,
    addsPunctuation: true,
    iosCategory,
    volumeChangeEventOptions: {
      enabled: true,
      intervalMillis: 250,
    },
    recordingOptions,
  };
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T | null> {
  return Promise.race([
    promise,
    new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs)),
  ]);
}

async function logSpeechEngineState(stage: string): Promise<void> {
  try {
    const state = await withTimeout(ExpoSpeechRecognitionModule.getStateAsync(), ENGINE_STATE_LOG_TIMEOUT_MS);
    LogService.debug('STT', state == null ? `${stage} recognizer state timed out` : `${stage} recognizer state: ${state}`);
  } catch (error) {
    LogService.debug('STT', `${stage} recognizer state unavailable: ${error}`);
  }
  if (Platform.OS === 'ios') {
    try {
      const audioSession = ExpoSpeechRecognitionModule.getAudioSessionCategoryAndOptionsIOS();
      LogService.debug(
        'STT',
        `${stage} iOS audio session: ${audioSession.category}/${audioSession.mode || 'default'} [${audioSession.categoryOptions.join(',')}]`,
      );
    } catch (error) {
      LogService.debug('STT', `${stage} iOS audio session unavailable: ${error}`);
    }
  }
}

function logSpeechEngineStateSoon(stage: string): void {
  const now = Date.now();
  if (now - lastEngineStateLogAt < ENGINE_STATE_LOG_INTERVAL_MS) return;
  lastEngineStateLogAt = now;
  void logSpeechEngineState(stage);
}

async function startRecognitionWithRetry(lang: string, retryDelayMs: number): Promise<void> {
  const options = buildRecognitionOptions(lang);

  try {
    ExpoSpeechRecognitionModule.start(options);
    LogService.info('STT', 'Speech recognition start() called');
    logSpeechEngineStateSoon('After start');
  } catch (error) {
    LogService.warn('STT', `Start failed on first try, retrying: ${error}`);
    try {
      ExpoSpeechRecognitionModule.abort();
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    ExpoSpeechRecognitionModule.start(buildRecognitionOptions(lang));
    LogService.info('STT', `Speech recognition start() retried after ${retryDelayMs}ms`);
    logSpeechEngineStateSoon('After retry');
  }
}

export const STTService = {
  async startListening({
    language = 'es',
    onSilenceDetected,
    onInterim,
    silenceTimeoutMs = DEFAULT_SILENCE_TIMEOUT_MS,
    finalSilenceTimeoutMs = DEFAULT_FINAL_SILENCE_TIMEOUT_MS,
    retryDelayMs = DEFAULT_RETRY_DELAY_MS,
    stopTimeoutMs = DEFAULT_STOP_TIMEOUT_MS,
    maxListeningDurationMs,
    persistAudio = false,
    diagnosticLabel = 'speech',
  }: STTStartOptions = {}): Promise<void> {
    if (!canUseSpeechRecognitionOnThisPlatform()) {
      throw new Error('El reconocimiento de voz no está disponible en este navegador. Usa el campo de texto en PC o prueba voz en iPhone/dev client.');
    }

    const { granted } = await ExpoSpeechRecognitionModule.requestPermissionsAsync();
    if (!granted) {
      throw new Error('Permiso de reconocimiento de voz denegado. Ve a Ajustes para habilitarlo.');
    }

    interimTranscript = '';
    silenceAlreadyFired = false;
    cleanup();
    onSilenceCallback = onSilenceDetected ?? null;
    onInterimCallback = onInterim ?? null;
    currentSilenceTimeoutMs = Math.max(500, silenceTimeoutMs);
    currentFinalSilenceTimeoutMs = Math.max(150, Math.min(finalSilenceTimeoutMs, currentSilenceTimeoutMs));
    currentStopTimeoutMs = Math.max(isWebSpeechPlatform() ? 1800 : 700, stopTimeoutMs);
    currentLang = toLang(language);
    currentRetryDelayMs = retryDelayMs;
    currentPersistAudio = persistAudio;
    currentDiagnosticLabel = diagnosticLabel.replace(/[^a-z0-9_-]/gi, '_').slice(0, 32) || 'speech';
    isStopRequested = false;
    webNoSpeechRestartCount = 0;
    webInitialListenDeadlineAt = isWebSpeechPlatform()
      ? Date.now() + WEB_INITIAL_SPEECH_TIMEOUT_MS
      : 0;
    initialListenDeadlineAt = Date.now() + (isWebSpeechPlatform()
      ? WEB_INITIAL_SPEECH_TIMEOUT_MS
      : NATIVE_INITIAL_SPEECH_TIMEOUT_MS);

    LogService.debug(
      'STT',
      `Requesting speech recognition (lang=${currentLang}, silence=${currentSilenceTimeoutMs}ms, final=${currentFinalSilenceTimeoutMs}ms, stop=${currentStopTimeoutMs}ms, persistAudio=${currentPersistAudio})`,
    );

    try {
      const permissions = await ExpoSpeechRecognitionModule.getPermissionsAsync();
      LogService.info(
        'STT',
        `Permissions: speech=${permissions.granted ? 'granted' : 'denied'} status=${permissions.status}`,
      );
    } catch {}

    if (isWebSpeechPlatform()) {
      await WebMicDiagnostics.start(currentDiagnosticLabel);
    }

    listeners.push(
      ExpoSpeechRecognitionModule.addListener('result', (event: ExpoSpeechRecognitionResultEvent) => {
        if (!event.results?.length) return;
        const text = event.results[0].transcript;
        interimTranscript = text;
        if (text.trim()) {
          webNoSpeechRestartCount = 0;
          resetSilenceTimer(Boolean(event.isFinal));
        } else if (!event.isFinal && Date.now() < initialListenDeadlineAt) {
          resetSilenceTimer(false, Math.max(500, initialListenDeadlineAt - Date.now()));
        } else {
          resetSilenceTimer(Boolean(event.isFinal));
        }
        LogService.debug('STT', `Result (${event.isFinal ? 'FINAL' : 'interim'}): "${text.substring(0, 80)}"`);
        onInterimCallback?.(text);
      }),
    );

    listeners.push(
      ExpoSpeechRecognitionModule.addListener('start', () => {
        LogService.info('STT', 'Speech recognition engine started');
      }),
    );

    listeners.push(
      ExpoSpeechRecognitionModule.addListener('audiostart', (event) => {
        const now = Date.now();
        if (now - lastAudioStartLogAt < 1500) return;
        lastAudioStartLogAt = now;
        LogService.info(
          'STT',
          `Audio capture started — microphone is active${event?.uri ? ` (recording: ${event.uri})` : ''}`,
        );
      }),
    );

    listeners.push(
      ExpoSpeechRecognitionModule.addListener('soundstart', () => {
        LogService.info('STT', 'Input sound detected');
      }),
    );

    listeners.push(
      ExpoSpeechRecognitionModule.addListener('speechstart', () => {
        LogService.info('STT', 'Speech detected — sigue hablando');
      }),
    );

    listeners.push(
      ExpoSpeechRecognitionModule.addListener('speechend', () => {
        LogService.info('STT', 'Speech ended');
      }),
    );

    listeners.push(
      ExpoSpeechRecognitionModule.addListener('soundend', () => {
        LogService.debug('STT', 'Input sound ended');
      }),
    );

    listeners.push(
      ExpoSpeechRecognitionModule.addListener('volumechange', (event) => {
        maxObservedVolume = Math.max(maxObservedVolume ?? event.value, event.value);
        const now = Date.now();
        if (event.value >= 0 && now - lastVolumeLogAt > 900) {
          lastVolumeLogAt = now;
          LogService.debug('STT', `Mic volume ${event.value.toFixed(1)} (max ${maxObservedVolume.toFixed(1)})`);
        }
      }),
    );

    listeners.push(
      ExpoSpeechRecognitionModule.addListener('nomatch', () => {
        LogService.warn('STT', 'Recognizer returned nomatch');
      }),
    );

    listeners.push(
      ExpoSpeechRecognitionModule.addListener('audioend', (event) => {
        const maxVolumeText = maxObservedVolume == null ? 'n/a' : maxObservedVolume.toFixed(1);
        LogService.info(
          'STT',
          `Audio capture ended (maxVolume=${maxVolumeText})${event?.uri ? ` recording=${event.uri}` : ''}`,
        );
      }),
    );

    listeners.push(
      ExpoSpeechRecognitionModule.addListener('end', () => {
        const hasTranscript = Boolean(interimTranscript.trim());
        LogService.debug('STT', `Recognition ended event. Has transcript: ${hasTranscript}`);
        if (isStopRequested) return;
        if (!hasTranscript && restartRecognitionAfterNoSpeech('Recognition ended before speech')) {
          return;
        }
        fireSilence();
      }),
    );

    listeners.push(
      ExpoSpeechRecognitionModule.addListener('error', (event: ExpoSpeechRecognitionErrorEvent) => {
        if (isAbortEvent(event)) {
          LogService.debug('STT', `Recognition aborted: ${event.message || event.error}`);
          return;
        }
        if (isNoSpeechEvent(event) && restartRecognitionAfterNoSpeech(`No speech event (${event.error})`)) {
          return;
        }
        LogService.error('STT', `Recognition error: ${event.error} — ${event.message || 'no details'}`);
        fireSilence();
      }),
    );

    if (maxListeningDurationMs && maxListeningDurationMs > 0) {
      maxListenTimer = setTimeout(() => {
        LogService.info('STT', `Max listening duration reached (${maxListeningDurationMs}ms)`);
        fireSilence();
      }, Math.max(3500, maxListeningDurationMs));
    }

    await startRecognitionWithRetry(currentLang, currentRetryDelayMs);
    resetSilenceTimer(false, isWebSpeechPlatform() ? WEB_INITIAL_SPEECH_TIMEOUT_MS : NATIVE_INITIAL_SPEECH_TIMEOUT_MS);
  },

  async stopAndGetTranscript(): Promise<string> {
    isStopRequested = true;
    return new Promise<string>((resolve) => {
      let resolved = false;

      const finish = async (text: string) => {
        if (resolved) return;
        resolved = true;
        clearTimeout(timeout);
        LogService.info('STT', `Final transcript: "${text.substring(0, 100)}" (${text.length} chars)`);
        cleanup();
        await stopWebMicDiagnostics();
        resolve(text);
      };

      const timeout = setTimeout(() => {
        LogService.warn('STT', `Safety timeout (${currentStopTimeoutMs}ms). Returning interim: "${interimTranscript.substring(0, 60)}"`);
        finish(interimTranscript || '');
      }, currentStopTimeoutMs);

      listeners.push(
        ExpoSpeechRecognitionModule.addListener('result', (event: ExpoSpeechRecognitionResultEvent) => {
          if (event.isFinal && event.results?.length) {
            finish(event.results[0].transcript);
          }
        }),
      );

      listeners.push(
        ExpoSpeechRecognitionModule.addListener('end', () => finish(interimTranscript || '')),
      );

      listeners.push(
        ExpoSpeechRecognitionModule.addListener('error', (event: ExpoSpeechRecognitionErrorEvent) => {
          if (isAbortEvent(event)) {
            finish(interimTranscript || '');
            return;
          }
          finish(interimTranscript || '');
        }),
      );

      ExpoSpeechRecognitionModule.stop();
    });
  },

  cancel(): void {
    isStopRequested = true;
    try {
      ExpoSpeechRecognitionModule.abort();
    } catch {}
    WebMicDiagnostics.stop().catch(() => {});
    cleanup();
  },

  getCurrentTranscript(): string {
    return interimTranscript;
  },

  getLastMicDiagnostics() {
    return WebMicDiagnostics.getLastSummary();
  },
};
