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
    try {
      if (player) {
        player.remove();
        player = null;
      }

      await this.prepareForPlayback();
      LogService.debug('Audio', `Playing audio: ${uri.substring(0, 60)}...`);

      player = createAudioPlayer({ uri }, { keepAudioSessionActive: true });

      await new Promise<void>((resolve, reject) => {
        const listener = player!.addListener('playbackStatusUpdate', (status) => {
          if (status.didJustFinish) {
            LogService.debug('Audio', 'Playback finished');
            listener.remove();
            player?.remove();
            player = null;
            onComplete?.();
            resolve();
          }
        });

        player!.play();
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      LogService.error('Audio', `Play error: ${msg}`);
      throw error;
    }
  },

  async stopPlayback(): Promise<void> {
    try {
      if (player) {
        player.remove();
        player = null;
      }
    } catch {}
  },

  isCurrentlyRecording(): boolean {
    return _isRecording;
  },
};
