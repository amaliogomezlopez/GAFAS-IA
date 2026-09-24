import {
  RecordingPresets,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
  createAudioPlayer,
} from 'expo-audio';
import type { AudioPlayer, AudioRecorder } from 'expo-audio';
import AudioModule from 'expo-audio/build/AudioModule';
import { createRecordingOptions } from 'expo-audio/build/utils/options';
import {
  AVAudioSessionCategory,
  AVAudioSessionCategoryOptions,
  AVAudioSessionMode,
  ExpoSpeechRecognitionModule,
} from 'expo-speech-recognition';
import { File } from 'expo-file-system';
import { Platform } from 'react-native';
import { LogService } from '../LogService';

export interface RecordingResult {
  uri: string;
  duration: number;
}

let recorder: AudioRecorder | null = null;
let player: AudioPlayer | null = null;
let recordingStartTime = 0;
let _isRecording = false;
let pendingPlayback: { player: AudioPlayer; settle: () => void } | null = null;

const PLAYBACK_LOAD_TIMEOUT_MS = 8000;
const PLAYBACK_MAX_DURATION_MS = 120_000;
const PLAYBACK_COMPLETION_GRACE_MS = 1500;

/** TTS responses are written to the cache as one-off files; don't let them pile up. */
function deleteCachedAudio(uri: string): void {
  if (!uri.includes('tts_output_')) return;
  try {
    const file = new File(uri);
    if (file.exists) file.delete();
  } catch {}
}

function configureIOSAudioSessionForBluetooth(mode: 'playback' | 'speech'): void {
  if (Platform.OS !== 'ios') return;

  try {
    if (mode === 'speech') {
      ExpoSpeechRecognitionModule.setCategoryIOS({
        category: AVAudioSessionCategory.playAndRecord,
        categoryOptions: [
          AVAudioSessionCategoryOptions.allowBluetooth,
          AVAudioSessionCategoryOptions.allowBluetoothA2DP,
          AVAudioSessionCategoryOptions.allowAirPlay,
        ],
        mode: AVAudioSessionMode.voiceChat,
      });
    } else {
      ExpoSpeechRecognitionModule.setCategoryIOS({
        category: AVAudioSessionCategory.playback,
        categoryOptions: [
          AVAudioSessionCategoryOptions.allowBluetoothA2DP,
          AVAudioSessionCategoryOptions.allowAirPlay,
        ],
        mode: AVAudioSessionMode.default,
      });
    }

    ExpoSpeechRecognitionModule.setAudioSessionActiveIOS(true, {
      notifyOthersOnDeactivation: false,
    });
    const session = ExpoSpeechRecognitionModule.getAudioSessionCategoryAndOptionsIOS();
    LogService.debug(
      'Audio',
      `iOS session ${mode}: ${session.category}/${session.mode} [${session.categoryOptions.join(', ')}]`,
    );
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    LogService.warn('Audio', `Could not configure iOS Bluetooth audio session: ${msg}`);
  }
}

export const AudioService = {
  async prepareForPlayback(): Promise<void> {
    await setAudioModeAsync({
      allowsRecording: false,
      playsInSilentMode: true,
      shouldPlayInBackground: true,
      shouldRouteThroughEarpiece: false,
      interruptionMode: 'doNotMix',
    });
    configureIOSAudioSessionForBluetooth('playback');
  },

  async prepareForBluetoothSpeech(): Promise<void> {
    await setAudioModeAsync({
      // Keep playAndRecord active on iOS so Bluetooth HFP glasses/headsets remain
      // eligible as the output route for native speech.
      allowsRecording: true,
      playsInSilentMode: true,
      shouldPlayInBackground: true,
      shouldRouteThroughEarpiece: false,
      interruptionMode: 'doNotMix',
    });
    configureIOSAudioSessionForBluetooth('speech');
  },

  async startRecording(): Promise<void> {
    const { granted } = await requestRecordingPermissionsAsync();
    if (!granted) {
      throw new Error('Permiso de micrófono denegado. Ve a Ajustes del iPhone para habilitarlo.');
    }

    await setAudioModeAsync({
      allowsRecording: true,
      playsInSilentMode: true,
      shouldPlayInBackground: true,
      shouldRouteThroughEarpiece: false,
      interruptionMode: 'doNotMix',
    });
    configureIOSAudioSessionForBluetooth('speech');

    const options = createRecordingOptions(RecordingPresets.HIGH_QUALITY);
    recorder = new AudioModule.AudioRecorder(options);
    await recorder.prepareToRecordAsync();
    recorder.record();

    recordingStartTime = Date.now();
    _isRecording = true;
  },

  async stopRecording(): Promise<RecordingResult> {
    _isRecording = false;

    if (!recorder) {
      return { uri: '', duration: 0 };
    }

    try {
      await recorder.stop();
    } catch {}

    await setAudioModeAsync({
      allowsRecording: false,
      playsInSilentMode: true,
      shouldPlayInBackground: true,
      shouldRouteThroughEarpiece: false,
      interruptionMode: 'doNotMix',
    });
    configureIOSAudioSessionForBluetooth('playback');

    const uri = recorder.uri || '';
    const duration = Date.now() - recordingStartTime;
    recorder = null;

    return { uri, duration };
  },

  async playAudio(uri: string, onComplete?: () => void): Promise<void> {
    // Stop (and settle) anything still playing so its promise doesn't hang.
    await this.stopPlayback();

    try {
      await this.prepareForPlayback();
    } catch (error) {
      LogService.warn('Audio', `Could not prepare playback session: ${error}`);
    }
    LogService.debug('Audio', `Playing audio: ${uri.substring(0, 60)}...`);

    const current = createAudioPlayer({ uri }, { keepAudioSessionActive: true });
    player = current;

    try {
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        let startedPlaying = false;
        const finish = (error?: Error) => {
          if (settled) return;
          settled = true;
          clearTimeout(loadTimeout);
          if (maxTimeout) clearTimeout(maxTimeout);
          listener.remove();
          if (pendingPlayback?.player === current) pendingPlayback = null;
          if (error) reject(error);
          else resolve();
        };

        // Resolved by stopPlayback() when the user interrupts.
        pendingPlayback = { player: current, settle: () => finish() };

        // A file that never loads would otherwise block the pipeline forever.
        const loadTimeout = setTimeout(() => {
          if (!startedPlaying) finish(new Error('El audio no se pudo cargar a tiempo.'));
        }, PLAYBACK_LOAD_TIMEOUT_MS);
        let maxTimeout: ReturnType<typeof setTimeout> | null = null;

        const listener = current.addListener('playbackStatusUpdate', (status) => {
          if (status.playing && !startedPlaying) {
            startedPlaying = true;
            const durationMs = Number.isFinite(status.duration) && status.duration > 0
              ? status.duration * 1000
              : PLAYBACK_MAX_DURATION_MS;
            maxTimeout = setTimeout(() => {
              LogService.warn('Audio', 'Playback did not report completion; continuing');
              finish();
            }, durationMs + PLAYBACK_COMPLETION_GRACE_MS);
          }
          if (status.didJustFinish) {
            LogService.debug('Audio', 'Playback finished');
            finish();
          }
        });

        current.play();
      });
      onComplete?.();
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      LogService.error('Audio', `Play error: ${msg}`);
      throw error;
    } finally {
      if (player === current) {
        try { current.remove(); } catch {}
        player = null;
      }
      deleteCachedAudio(uri);
    }
  },

  async stopPlayback(): Promise<void> {
    const pending = pendingPlayback;
    pendingPlayback = null;
    try {
      if (player) {
        player.pause();
        player.remove();
        player = null;
      }
    } catch {}
    pending?.settle();
  },

  isCurrentlyRecording(): boolean {
    return _isRecording;
  },
};
