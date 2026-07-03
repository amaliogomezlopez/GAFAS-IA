/**
 * WakeWordService — Passive listener for configurable wake phrase.
 *
 * Uses expo-speech-recognition in continuous mode. When the wake word
 * is detected, triggers a callback and stops listening temporarily
 * so the main pipeline can take over.
 *
 * KEY FIX (v0.7): Added cooldown mechanism to prevent TTS audio
 * being picked up by the mic and re-triggering the wake word
 * (the assistant hears its own TTS and wakes itself again).
 */
import {
  AVAudioSessionCategory,
  AVAudioSessionCategoryOptions,
  AVAudioSessionMode,
  ExpoSpeechRecognitionModule,
} from 'expo-speech-recognition';
import type { ExpoSpeechRecognitionResultEvent } from 'expo-speech-recognition';
import { Platform } from 'react-native';
import { LogService } from './LogService';

type WakeDetection = {
  transcript: string;
  command?: string;
};
type WakeCallback = (detection?: WakeDetection) => void;
type WakeWordConfig = {
  cooldownMs?: number;
  resumeDelayMs?: number;
  minTriggerIntervalMs?: number;
};

let isActive = false;
let isPaused = false;
let wakePhrase = 'kairo';
let wakeLang = 'es-ES';
let onWake: WakeCallback | null = null;
let restartTimer: ReturnType<typeof setTimeout> | null = null;
let listeners: Array<{ remove: () => void }> = [];

/** Cooldown: ignore detections until this timestamp passes */
let cooldownUntil = 0;
/** Runtime-tuned values so we can optimize latency without hardcoded waits */
let cooldownAfterResumeMs = 1200;
let resumeDelayMs = 350;
let minTriggerIntervalMs = 2800;
let lastTriggerTime = 0;
let lastRecognitionStartLogAt = 0;
let lastWakeResultLogAt = 0;
let lastWakeResultLogText = '';
let lastNoSpeechLogAt = 0;
let lastWakeLifecycleLogAt = 0;
let lastWakeVolumeLogAt = 0;
let lastWakeAudioStartLogAt = 0;
let wakeCycleHadResult = false;
let wakeMaxObservedVolume: number | null = null;
let webUnsupportedLogged = false;

function canUseSpeechRecognitionOnThisPlatform(): boolean {
  if (Platform.OS !== 'web') return true;
  const globalObject = globalThis as typeof globalThis & {
    SpeechRecognition?: unknown;
    webkitSpeechRecognition?: unknown;
  };
  return Boolean(globalObject.SpeechRecognition || globalObject.webkitSpeechRecognition);
}

function getRestartDelayMs(kind: 'end' | 'no-speech' | 'error'): number {
  if (Platform.OS !== 'web') {
    if (kind === 'end') return 160;
    if (kind === 'no-speech') return 120;
    return 650;
  }
  if (kind === 'end') return 900;
  if (kind === 'no-speech') return 1100;
  return 1800;
}

function cleanListeners() {
  listeners.forEach((l) => { try { l.remove(); } catch {} });
  listeners = [];
}

function normalize(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // strip accents
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function wordMatches(transcriptWord: string, phraseWord: string): boolean {
  if (transcriptWord === phraseWord) return true;
  if (transcriptWord.length >= 4 && transcriptWord.includes(phraseWord)) return true;
  if (
    phraseWord.length >= 4 &&
    transcriptWord.length >= Math.max(4, phraseWord.length - 1) &&
    phraseWord.includes(transcriptWord)
  ) {
    return true;
  }
  return false;
}

/** Simple word-level similarity: check if every word of the wake phrase
 * appears in the transcript without accepting tiny partial words. */
function fuzzyMatch(transcript: string, phrase: string): boolean {
  // Exact substring match
  if (transcript.includes(phrase)) return true;

  // Word-level: all wake words must appear in transcript
  const phraseWords = phrase.split(' ').filter(w => w.length > 0);
  if (phraseWords.length === 0) return false;
  const transcriptWords = transcript.split(' ').filter(w => w.length > 0);
  if (transcriptWords.join('').length < Math.max(4, phrase.replace(/\s/g, '').length - 1)) {
    return false;
  }
  const matched = phraseWords.every(w =>
    transcriptWords.some(tw => wordMatches(tw, w))
  );
  if (matched) return true;

  // Phonetic variants for common wake words
  const variants: Record<string, string[]> = {
    'aimbi': ['aimbi', 'aimbee', 'aimby', 'aimebi', 'eimbi', 'einbi', 'ambi', 'aimb'],
    'aimb': ['aimb', 'aimbi', 'aimbee', 'aimebi', 'eimbi', 'einbi', 'ambi'],
    'kairo': ['kairo', 'cairo', 'cayro', 'kaido', 'cairoh', 'kayro', 'quiro', 'kiro'],
    'sibel': ['sibel', 'sivel', 'cibel', 'si bel'],
    'nexo': ['nexo', 'neso', 'anexo'],
    's1': ['s1', 'ese uno', 's uno', 'es uno'],
    'glasses': ['glasses', 'glases', 'grases'],
    'gafas': ['gafas', 'gafa'],
  };
  for (const [word, alts] of Object.entries(variants)) {
    const phraseWord = phraseWords.find((w) => w === word || w.includes(word) || alts.includes(w));
    if (phraseWord) {
      const others = phraseWords.filter(w => w !== phraseWord);
      const othersOk = others.length === 0 || others.every(w =>
        transcript.split(' ').some(tw => tw === w || tw.includes(w))
      );
      if (othersOk && alts.some(alt => transcript.includes(alt))) return true;
    }
  }

  return false;
}

function extractInlineCommand(transcript: string, phrase: string): string | undefined {
  const index = transcript.indexOf(phrase);
  if (index < 0) return undefined;
  const command = transcript.slice(index + phrase.length).trim();
  return command.length >= 3 ? command : undefined;
}

function logWakeHypothesis(originalTranscript: string, normalizedTranscript: string): void {
  if (!originalTranscript.trim()) return;

  if (Platform.OS === 'web') {
    LogService.info('WakeWord', `Heard while waiting: "${originalTranscript}"`);
    return;
  }

  const now = Date.now();
  const changed = normalizedTranscript !== lastWakeResultLogText;
  if (!changed && now - lastWakeResultLogAt < 1500) return;
  if (changed && now - lastWakeResultLogAt < 650) return;

  lastWakeResultLogAt = now;
  lastWakeResultLogText = normalizedTranscript;
  LogService.info('WakeWord', `Heard while waiting: "${originalTranscript}"`);
}

export const WakeWordService = {
  /** Start passive wake word detection */
  async start(phrase: string, callback: WakeCallback, lang?: string, config?: WakeWordConfig): Promise<void> {
    if (isActive) return;

    if (!canUseSpeechRecognitionOnThisPlatform()) {
      if (!webUnsupportedLogged) {
        LogService.warn(
          'WakeWord',
          'Wake word disabled because this runtime does not expose SpeechRecognition. Use manual input or run the iOS/dev-client build.',
        );
        webUnsupportedLogged = true;
      }
      return;
    }

    const { granted } = await ExpoSpeechRecognitionModule.requestPermissionsAsync();
    if (!granted) {
      LogService.warn('WakeWord', 'Speech recognition permission denied');
      return;
    }

    wakePhrase = normalize(phrase);
    wakeLang = lang || 'es-ES';
    onWake = callback;
    if (config) {
      cooldownAfterResumeMs = Math.max(350, config.cooldownMs ?? cooldownAfterResumeMs);
      resumeDelayMs = Math.max(50, config.resumeDelayMs ?? resumeDelayMs);
      minTriggerIntervalMs = Math.max(900, config.minTriggerIntervalMs ?? minTriggerIntervalMs);
    }
    isActive = true;
    isPaused = false;
    LogService.info(
      'WakeWord',
      `Listening for wake phrase: "${phrase}" (normalized: "${wakePhrase}", lang: ${wakeLang}, cooldown=${cooldownAfterResumeMs}ms)`,
    );

    this._startRecognition();
  },

  _startRecognition(): void {
    if (!isActive || isPaused) return;
    if (!canUseSpeechRecognitionOnThisPlatform()) {
      LogService.warn('WakeWord', 'Speech recognition unavailable; stopping wake listener');
      this.stop();
      return;
    }
    cleanListeners();

    // NOTE: Do NOT call setAudioModeAsync here.
    // expo-speech-recognition manages its own iOS audio session.
    // Overriding it causes speech recognition to stop working.

    const now = Date.now();
    if (now - lastRecognitionStartLogAt > 4500) {
      lastRecognitionStartLogAt = now;
      LogService.debug('WakeWord', 'Recognition start() requested');
    }
    wakeCycleHadResult = false;
    wakeMaxObservedVolume = null;

    const scheduleRestart = (kind: 'end' | 'no-speech' | 'error') => {
      if (!isActive || isPaused || restartTimer) return;
      restartTimer = setTimeout(() => {
        restartTimer = null;
        this._startRecognition();
      }, getRestartDelayMs(kind));
    };

    listeners.push(
      ExpoSpeechRecognitionModule.addListener('result', (event: ExpoSpeechRecognitionResultEvent) => {
        if (!event.results?.length) return;
        const originalTranscript = event.results[0].transcript;
        const transcript = normalize(originalTranscript);
        wakeCycleHadResult = true;
        logWakeHypothesis(originalTranscript, transcript);

        // Cooldown guard: ignore detections right after TTS playback
        if (Date.now() < cooldownUntil) {
          LogService.debug('WakeWord', `Ignoring during cooldown: "${originalTranscript}"`);
          return;
        }

        if (fuzzyMatch(transcript, wakePhrase)) {
          // Rate-limit guard: prevent rapid re-triggering
          if (Date.now() - lastTriggerTime < minTriggerIntervalMs) {
            LogService.debug('WakeWord', 'Ignoring rapid re-trigger');
            return;
          }
          const inlineCommand = extractInlineCommand(transcript, wakePhrase);
          LogService.info(
            'WakeWord',
            `Wake phrase detected: "${originalTranscript}"${inlineCommand ? ` -> "${inlineCommand}"` : ''}`,
          );
          this._onDetected({ transcript: originalTranscript, command: inlineCommand });
        }
      }),
    );

    listeners.push(
      ExpoSpeechRecognitionModule.addListener('start', () => {
        const startedAt = Date.now();
        if (startedAt - lastWakeLifecycleLogAt > 4500) {
          lastWakeLifecycleLogAt = startedAt;
          LogService.debug('WakeWord', 'Recognition engine started');
        }
      }),
    );

    listeners.push(
      ExpoSpeechRecognitionModule.addListener('audiostart', () => {
        const audioStartAt = Date.now();
        if (audioStartAt - lastWakeAudioStartLogAt > 4500) {
          lastWakeAudioStartLogAt = audioStartAt;
          LogService.debug('WakeWord', 'Audio capture started while waiting');
        }
      }),
    );

    listeners.push(
      ExpoSpeechRecognitionModule.addListener('soundstart', () => {
        LogService.info('WakeWord', 'Input sound detected while waiting');
      }),
    );

    listeners.push(
      ExpoSpeechRecognitionModule.addListener('speechstart', () => {
        LogService.info('WakeWord', 'Speech detected while waiting');
      }),
    );

    listeners.push(
      ExpoSpeechRecognitionModule.addListener('speechend', () => {
        LogService.debug('WakeWord', 'Speech ended while waiting');
      }),
    );

    listeners.push(
      ExpoSpeechRecognitionModule.addListener('volumechange', (event) => {
        wakeMaxObservedVolume = Math.max(wakeMaxObservedVolume ?? event.value, event.value);
        const volumeAt = Date.now();
        if (event.value >= 0 && volumeAt - lastWakeVolumeLogAt > 1400) {
          lastWakeVolumeLogAt = volumeAt;
          LogService.debug(
            'WakeWord',
            `Mic volume while waiting ${event.value.toFixed(1)} (max ${wakeMaxObservedVolume.toFixed(1)})`,
          );
        }
      }),
    );

    listeners.push(
      ExpoSpeechRecognitionModule.addListener('audioend', () => {
        const maxVolumeText = wakeMaxObservedVolume == null ? 'n/a' : wakeMaxObservedVolume.toFixed(1);
        LogService.debug('WakeWord', `Audio capture ended while waiting (maxVolume=${maxVolumeText})`);
      }),
    );

    listeners.push(
      ExpoSpeechRecognitionModule.addListener('end', () => {
        const endedAt = Date.now();
        if (endedAt - lastWakeLifecycleLogAt > 1800) {
          lastWakeLifecycleLogAt = endedAt;
          const maxVolumeText = wakeMaxObservedVolume == null ? 'n/a' : wakeMaxObservedVolume.toFixed(1);
          LogService.debug(
            'WakeWord',
            `Recognition ended. Had result: ${wakeCycleHadResult}; maxVolume=${maxVolumeText}; restarting=${isActive && !isPaused}`,
          );
        }
        // Recognition ended naturally — restart after short delay
        scheduleRestart('end');
      }),
    );

    listeners.push(
      ExpoSpeechRecognitionModule.addListener('error', (evt: any) => {
        const err = evt?.error || 'unknown';
        // "no-speech" is normal — just means silence, restart quickly
        const isNoSpeech = err === 'no-speech' || err === 'no_speech';
        if (!isNoSpeech) {
          LogService.debug('WakeWord', `Recognition error: ${err}`);
        } else if (Date.now() - lastNoSpeechLogAt > 5000) {
          lastNoSpeechLogAt = Date.now();
          LogService.debug('WakeWord', 'Recognition reported no-speech; restarting');
        }
        scheduleRestart(isNoSpeech ? 'no-speech' : 'error');
      }),
    );

    try {
      ExpoSpeechRecognitionModule.start({
        lang: wakeLang,
        interimResults: true,
        continuous: Platform.OS !== 'web',
        addsPunctuation: false,
        contextualStrings: [wakePhrase],
        volumeChangeEventOptions: {
          enabled: true,
          intervalMillis: 500,
        },
        iosTaskHint: 'search',
        iosCategory: Platform.OS === 'ios'
          ? {
              category: AVAudioSessionCategory.playAndRecord,
              categoryOptions: [
                AVAudioSessionCategoryOptions.allowBluetooth,
                AVAudioSessionCategoryOptions.allowBluetoothA2DP,
                AVAudioSessionCategoryOptions.allowAirPlay,
              ],
              mode: AVAudioSessionMode.default,
            }
          : undefined,
      });
    } catch (e) {
      LogService.error('WakeWord', `Failed to start recognition: ${e}`);
      if (String(e).includes('SpeechRecognition is not defined')) {
        this.stop();
        return;
      }
      // Retry after delay
      if (isActive && !isPaused && !restartTimer) {
        restartTimer = setTimeout(() => {
          restartTimer = null;
          this._startRecognition();
        }, 1500);
      }
    }
  },

  _onDetected(detection?: WakeDetection): void {
    lastTriggerTime = Date.now();
    // Temporarily stop wake listening so the main pipeline can use STT
    this.pause();
    onWake?.(detection);
  },

  /** Pause wake word listening (e.g. while pipeline is active) */
  pause(): void {
    isPaused = true;
    if (restartTimer) { clearTimeout(restartTimer); restartTimer = null; }
    cleanListeners();
    try { ExpoSpeechRecognitionModule.abort(); } catch {}
  },

  /** Resume wake word listening after pipeline finishes.
   *  Includes a cooldown window to prevent TTS echo from BLE speakers
   *  being detected as a wake word (the infinite loop fix). */
  resume(options?: { cooldownMs?: number; delayMs?: number }): void {
    if (!isActive) return;
    isPaused = false;
    const cooldownMs = options?.cooldownMs ?? cooldownAfterResumeMs;
    const delayMs = options?.delayMs ?? resumeDelayMs;
    cooldownUntil = Date.now() + cooldownMs;
    LogService.debug('WakeWord', `Resuming with ${cooldownMs}ms cooldown`);
    if (restartTimer) { clearTimeout(restartTimer); restartTimer = null; }
    restartTimer = setTimeout(() => this._startRecognition(), delayMs);
  },

  /** Completely stop wake word detection */
  stop(): void {
    isActive = false;
    isPaused = false;
    onWake = null;
    this.pause();
    LogService.info('WakeWord', 'Stopped');
  },

  isListening(): boolean {
    return isActive && !isPaused;
  },
};
