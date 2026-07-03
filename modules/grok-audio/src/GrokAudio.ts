import { requireNativeModule } from 'expo-modules-core';
import { Platform } from 'react-native';

// Native module shape produced by GrokAudioModule.swift.
type GrokAudioNative = {
  startSession(): boolean;
  stopSession(): void;
  startPlaybackSession(): boolean;
  stopPlaybackSession(): void;
  clearPlayback(): void;
  startCapture(): boolean;
  stopCapture(): void;
  enqueueAudio(base64: string): Promise<boolean>;
  interrupt(): void;
  setMuted(muted: boolean): void;
  addListener(eventName: string, listener: (event: any) => void): { remove(): void };
  removeListeners(count: number): void;
};

export type GrokAudioEvent =
  | 'onAudioData' // captured mic PCM16 (base64) → send to WS
  | 'onStateChange' // native session state transitions
  | 'onError' // native audio errors
  | 'onPlaybackFinished';

let _native: GrokAudioNative | null = null;

function loadNative(): GrokAudioNative | null {
  if (Platform.OS !== 'ios') return null;
  try {
    // requireNativeModule throws if the module isn't registered (e.g. Expo Go).
    _native = requireNativeModule('GrokAudio') as unknown as GrokAudioNative;
    return _native;
  } catch {
    return null;
  }
}

export interface GrokAudioSubscription {
  remove(): void;
}

/**
 * Thin typed wrapper around the native `GrokAudio` module.
 *
 * All capture/playback happens in native code; JS just shuttles base64 PCM16
 * between this module and the realtime WebSocket client. Events are how native
 * pushes captured mic frames back up to JS.
 *
 * Requires an Expo dev-client (native build) on iOS — not available in Expo Go.
 */
export const GrokAudio = {
  get isAvailable(): boolean {
    return (_native ?? loadNative()) !== null;
  },

  _ensure(): GrokAudioNative {
    const native = _native ?? loadNative();
    if (!native) {
      throw new Error(
        Platform.OS === 'ios'
          ? 'El módulo de voz Grok no está disponible. Necesitas un dev-client nativo (no Expo Go); ejecuta expo prebuild y recompila.'
          : 'El modo de voz Grok realtime solo está disponible en iOS por ahora.'
      );
    }
    return native;
  },

  startSession(): boolean {
    return this._ensure().startSession();
  },
  stopSession(): void {
    this._ensure().stopSession();
  },
  startPlaybackSession(): boolean {
    return this._ensure().startPlaybackSession();
  },
  stopPlaybackSession(): void {
    this._ensure().stopPlaybackSession();
  },
  clearPlayback(): void {
    this._ensure().clearPlayback();
  },
  startCapture(): boolean {
    return this._ensure().startCapture();
  },
  stopCapture(): void {
    this._ensure().stopCapture();
  },
  enqueueAudio(base64: string): Promise<boolean> {
    return this._ensure().enqueueAudio(base64);
  },
  interrupt(): void {
    this._ensure().interrupt();
  },
  setMuted(muted: boolean): void {
    this._ensure().setMuted(muted);
  },

  /** Subscribe to a native GrokAudio event. Returns a subscription with remove(). */
  addListener(event: GrokAudioEvent, listener: (payload: any) => void): GrokAudioSubscription {
    return this._ensure().addListener(event, listener);
  },
};

export default GrokAudio;
