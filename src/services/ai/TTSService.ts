import { File, Paths } from 'expo-file-system';
import * as Speech from 'expo-speech';
import type { Voice as NativeVoice } from 'expo-speech';
import { Platform } from 'react-native';
import { SecureStorage } from '../secure-storage';
import { getProxyAuthHeaders } from '../proxy-auth';
import { API_ENDPOINTS } from '../../constants';
import type { TTSProvider, TTSVoice } from '../../types';
import { AudioService } from '../audio';
import { LogService } from '../LogService';

type TTSOptions = {
  language?: string;
  rate?: number;
  pitch?: number;
  nativeVoiceId?: string;
  signal?: AbortSignal;
};

type StreamingSpeakerOptions = TTSOptions & {
  onChunkStart?: (text: string) => void;
};

export type StreamingSpeaker = {
  pushText: (delta: string) => void;
  finish: () => Promise<void>;
  stop: () => void;
};

const sanitizeError = (status: number, body: string): string => {
  const sanitized = body.replace(/(?:sk-|Bearer\s+)[a-zA-Z0-9_-]{10,}/g, '[REDACTED]');
  const truncated = sanitized.length > 200 ? sanitized.substring(0, 200) + '...' : sanitized;
  return `TTS error (${status}): ${truncated}`;
};

const hexToBase64 = (hex: string): string => {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substr(i, 2), 16);
  }
  let binary = '';
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary);
};

const blobToBase64 = (blob: Blob): Promise<string> => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const dataUrl = reader.result as string;
      resolve(dataUrl.split(',')[1]);
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function toEdgeRate(rate: number): string {
  const percentage = Math.round((rate - 1) * 100);
  return `${percentage >= 0 ? '+' : ''}${percentage}%`;
}

async function writeBlobToCache(blob: Blob, extension: string = 'mp3'): Promise<string> {
  const base64 = await blobToBase64(blob);
  const file = new File(Paths.cache, `tts_output_${Date.now()}.${extension}`);
  file.write(base64, { encoding: 'base64' });
  return file.uri;
}

export const TTSService = {
  createStreamingSpeaker(
    provider: TTSProvider = 'native',
    voice: string = 'native-ios',
    options: StreamingSpeakerOptions = {},
  ): StreamingSpeaker {
    let buffer = '';
    let stopped = false;
    let queue = Promise.resolve();

    const enqueue = (text: string) => {
      const phrase = text.trim();
      if (!phrase || stopped || options.signal?.aborted) return;
      queue = queue
        .then(async () => {
          if (stopped || options.signal?.aborted) return;
          options.onChunkStart?.(phrase);
          await this.synthesize(phrase, provider, voice, options);
        })
        .catch((error) => {
          const message = error instanceof Error ? error.message : String(error);
          LogService.warn('TTS', `Chunk playback failed: ${message}`);
        });
    };

    const flushReadyPhrases = () => {
      const phrases: string[] = [];
      let lastEnd = 0;
      const matcher = /[^.!?¡¿\n]{24,}?[.!?]+(?:\s+|$)|[^\n]{72,}(?:,|;|:|\n|\s$)/g;
      let match: RegExpExecArray | null;
      while ((match = matcher.exec(buffer)) !== null) {
        const chunk = match[0].trim();
        if (chunk.length >= 18) {
          phrases.push(chunk);
          lastEnd = matcher.lastIndex;
        }
      }
      if (lastEnd > 0) {
        buffer = buffer.slice(lastEnd);
      }
      phrases.forEach(enqueue);
    };

    return {
      pushText(delta: string) {
        if (!delta || stopped) return;
        buffer += delta;
        flushReadyPhrases();
      },
      async finish() {
        const tail = buffer.trim();
        buffer = '';
        if (tail) enqueue(tail);
        await queue;
      },
      stop() {
        stopped = true;
        buffer = '';
      },
    };
  },

  async getAvailableNativeVoices(languagePrefix: string = 'es'): Promise<TTSVoice[]> {
    try {
      const voices = await Speech.getAvailableVoicesAsync();
      return voices
        .filter((voice: NativeVoice) => {
          if (!languagePrefix) return true;
          return voice.language.toLowerCase().startsWith(languagePrefix.toLowerCase());
        })
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((voice: NativeVoice) => ({
          id: voice.identifier,
          name: `${voice.name} (${voice.language})`,
          provider: 'native',
          language: voice.language,
        }));
    } catch (error) {
      LogService.warn('TTS', `Unable to query native voices: ${error}`);
      return [];
    }
  },

  async synthesize(
    text: string,
    provider: TTSProvider = 'native',
    voice: string = 'native-ios',
    options: TTSOptions = {},
  ): Promise<void> {
    LogService.info('TTS', `Synthesizing (${provider}/${voice}): "${text.substring(0, 60)}..."`);

    if (provider === 'native') {
      await synthesizeNative(text, voice, options);
      return;
    }

    if (provider === 'server') {
      try {
        const audioFilePath = await synthesizeServer(text, voice, options);
        LogService.info('TTS', 'Audio file ready, starting playback...');
        await AudioService.playAudio(audioFilePath);
        LogService.info('TTS', 'TTS playback complete');
        return;
      } catch (error) {
        LogService.warn('TTS', `Server TTS failed, falling back to native: ${error}`);
        await synthesizeNative(text, 'native-ios', options);
        return;
      }
    }

    if (provider === 'kokoro') {
      try {
        const audioFilePath = await synthesizeKokoro(text, voice, options);
        LogService.info('TTS', 'Kokoro audio ready, starting playback...');
        await AudioService.playAudio(audioFilePath);
        LogService.info('TTS', 'Kokoro playback complete');
        return;
      } catch (error) {
        LogService.warn('TTS', `Kokoro failed, falling back to server/native: ${error}`);
        try {
          const audioFilePath = await synthesizeServer(text, 'es-ES-AlvaroNeural', options);
          await AudioService.playAudio(audioFilePath);
          return;
        } catch {
          await synthesizeNative(text, 'native-ios', options);
          return;
        }
      }
    }

    const providerKey = provider === 'minimax'
      ? 'minimax'
      : provider === 'elevenlabs'
        ? 'elevenlabs'
        : 'openai';
    const apiKey = await SecureStorage.getAPIKey(providerKey);
    if (!apiKey) {
      throw new Error(`${provider} API key not configured. Ve a Ajustes para añadirla.`);
    }

    let audioFilePath: string;

    switch (provider) {
      case 'openai':
        audioFilePath = await synthesizeOpenAI(apiKey, text, voice, options.signal);
        break;
      case 'elevenlabs':
        audioFilePath = await synthesizeElevenLabs(apiKey, text, voice, options.signal);
        break;
      case 'minimax': {
        const groupId = await SecureStorage.getAPIKey('minimaxGroupId');
        if (!groupId) {
          throw new Error('MiniMax Group ID not configured. Ve a Ajustes para añadirlo.');
        }
        audioFilePath = await synthesizeMiniMax(apiKey, groupId, text, voice, options.signal);
        break;
      }
      default:
        throw new Error(`TTS provider no soportado: ${provider}`);
    }

    LogService.info('TTS', 'Audio file ready, starting playback...');
    await AudioService.playAudio(audioFilePath);
    LogService.info('TTS', 'TTS playback complete');
  },
};

async function synthesizeOpenAI(apiKey: string, text: string, voice: string, signal?: AbortSignal): Promise<string> {
  LogService.info('TTS', `[OpenAI] Starting synthesis, voice=${voice}, text length=${text.length}`);
  const response = await fetch(API_ENDPOINTS.openai.tts, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'tts-1',
      input: text,
      voice,
      response_format: 'mp3',
    }),
    signal,
  });

  if (!response.ok) {
    throw new Error(sanitizeError(response.status, await response.text()));
  }

  const blob = await response.blob();
  LogService.info('TTS', `[OpenAI] Audio blob received, size=${blob.size} bytes`);
  const path = await writeBlobToCache(blob);
  LogService.info('TTS', `[OpenAI] Audio saved to ${path}`);
  return path;
}

async function synthesizeElevenLabs(apiKey: string, text: string, voice: string, signal?: AbortSignal): Promise<string> {
  LogService.info('TTS', `[ElevenLabs] Starting synthesis, voice=${voice}, text length=${text.length}`);
  const response = await fetch(`${API_ENDPOINTS.elevenlabs.tts}/${voice}`, {
    method: 'POST',
    headers: {
      'xi-api-key': apiKey,
      'Content-Type': 'application/json',
      Accept: 'audio/mpeg',
    },
    body: JSON.stringify({
      text,
      model_id: 'eleven_multilingual_v2',
    }),
    signal,
  });

  if (!response.ok) {
    throw new Error(sanitizeError(response.status, await response.text()));
  }

  const blob = await response.blob();
  LogService.info('TTS', `[ElevenLabs] Audio blob received, size=${blob.size} bytes`);
  const path = await writeBlobToCache(blob);
  LogService.info('TTS', `[ElevenLabs] Audio saved to ${path}`);
  return path;
}

async function synthesizeMiniMax(apiKey: string, groupId: string, text: string, voice: string, signal?: AbortSignal): Promise<string> {
  LogService.info('TTS', `[MiniMax] Starting synthesis, voice=${voice}, text length=${text.length}`);
  const response = await fetch(`${API_ENDPOINTS.minimax.tts}?GroupId=${groupId}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'speech-02-hd',
      text,
      stream: false,
      voice_setting: {
        voice_id: voice,
        speed: 1.08,
        vol: 1.0,
        pitch: 0,
      },
      audio_setting: {
        sample_rate: 32000,
        bitrate: 128000,
        format: 'mp3',
      },
    }),
    signal,
  });

  if (!response.ok) {
    throw new Error(sanitizeError(response.status, await response.text()));
  }

  const data = await response.json();
  if (data.base_resp && data.base_resp.status_code !== 0) {
    throw new Error(
      `MiniMax TTS error: ${data.base_resp.status_msg || 'Unknown error'} (code: ${data.base_resp.status_code})`,
    );
  }

  const hexAudio = data.data?.audio;
  if (!hexAudio) {
    throw new Error('MiniMax TTS: No audio data in response');
  }

  const file = new File(Paths.cache, `tts_output_${Date.now()}.mp3`);
  file.write(hexToBase64(hexAudio), { encoding: 'base64' });
  LogService.info('TTS', `[MiniMax] Audio saved to ${file.uri}`);
  return file.uri;
}

async function synthesizeServer(text: string, voice: string, options: TTSOptions): Promise<string> {
  LogService.info('TTS', `[Server] Starting edge-tts synthesis, voice=${voice}`);
  const response = await fetch(API_ENDPOINTS.proxy.ttsEdge, {
    method: 'POST',
    headers: {
      ...(await getProxyAuthHeaders()),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      text,
      voice,
      rate: toEdgeRate(clamp(options.rate ?? 1.08, 0.85, 1.35)),
      volume: '+0%',
    }),
    signal: options.signal,
  });

  if (!response.ok) {
    throw new Error(sanitizeError(response.status, await response.text()));
  }

  const blob = await response.blob();
  LogService.info('TTS', `[Server] Audio blob received, size=${blob.size} bytes`);
  const path = await writeBlobToCache(blob, 'mp3');
  LogService.info('TTS', `[Server] Audio saved to ${path}`);
  return path;
}

async function synthesizeKokoro(text: string, voice: string, options: TTSOptions): Promise<string> {
  LogService.info('TTS', `[Kokoro] Starting synthesis, voice=${voice}, text length=${text.length}`);
  const response = await fetch(API_ENDPOINTS.proxy.ttsKokoro, {
    method: 'POST',
    headers: {
      ...(await getProxyAuthHeaders()),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      text,
      voice,
      speed: clamp(options.rate ?? 1.05, 0.8, 1.35),
      language: options.language || 'es',
    }),
    signal: options.signal,
  });

  if (!response.ok) {
    throw new Error(sanitizeError(response.status, await response.text()));
  }

  const blob = await response.blob();
  const contentType = response.headers.get('Content-Type') || '';
  const extension = contentType.includes('wav') ? 'wav' : 'mp3';
  LogService.info('TTS', `[Kokoro] Audio blob received, size=${blob.size} bytes`);
  const path = await writeBlobToCache(blob, extension);
  LogService.info('TTS', `[Kokoro] Audio saved to ${path}`);
  return path;
}

let nativeVoiceCache: TTSVoice[] | null = null;

async function pickBestNativeVoiceId(language: string): Promise<string | undefined> {
  try {
    if (!nativeVoiceCache) {
      nativeVoiceCache = await TTSService.getAvailableNativeVoices('');
    }
    const prefix = language.toLowerCase().slice(0, 2);
    const candidates = nativeVoiceCache.filter((voice) => voice.language.toLowerCase().startsWith(prefix));
    const scored = candidates
      .map((voice) => {
        const text = `${voice.id} ${voice.name}`.toLowerCase();
        const score =
          (text.includes('premium') ? 5 : 0) +
          (text.includes('enhanced') ? 4 : 0) +
          (text.includes('neural') ? 3 : 0) +
          (text.includes('monica') || text.includes('jorge') || text.includes('paulina') ? 2 : 0);
        return { voice, score };
      })
      .sort((a, b) => b.score - a.score || a.voice.name.localeCompare(b.voice.name));
    return scored[0]?.voice.id;
  } catch {
    return undefined;
  }
}

async function synthesizeNative(text: string, voiceId: string, options: TTSOptions): Promise<void> {
  const langMap: Record<string, string> = {
    'native-ios': 'es-ES',
    'native-en': 'en-US',
    'native-mx': 'es-MX',
  };
  const isConcreteNativeVoice = !Object.prototype.hasOwnProperty.call(langMap, voiceId);
  const language = isConcreteNativeVoice
    ? options.language || 'es-ES'
    : langMap[voiceId] || options.language || 'es-ES';
  const rate = clamp(options.rate ?? 1.08, 0.8, 1.4);
  const pitch = clamp(options.pitch ?? 1.0, 0.5, 1.5);
  const nativeVoice = isConcreteNativeVoice
    ? voiceId
    : options.nativeVoiceId || await pickBestNativeVoiceId(language);

  if (!text || text.trim().length === 0) {
    LogService.warn('TTS', '[Native] Empty text, skipping');
    return;
  }

  LogService.info(
    'TTS',
    `[Native] Starting synthesis (lang=${language}, rate=${rate.toFixed(2)}, voice=${options.nativeVoiceId || voiceId})`,
  );

  try {
    if (Platform.OS === 'ios') {
      await AudioService.prepareForBluetoothSpeech();
    } else {
      await AudioService.prepareForPlayback();
    }
  } catch (error) {
    LogService.warn('TTS', `[Native] Could not prepare playback session: ${error}`);
  }

  return new Promise((resolve, reject) => {

    const timeout = setTimeout(() => {
      Speech.stop();
      LogService.warn('TTS', '[Native] Timed out after 45s');
      resolve();
    }, 45_000);

    const abortListener = () => {
      clearTimeout(timeout);
      Speech.stop();
      LogService.warn('TTS', '[Native] Aborted');
      resolve();
    };

    if (options.signal?.aborted) {
      abortListener();
      return;
    }
    options.signal?.addEventListener('abort', abortListener, { once: true });

    Speech.speak(text, {
      language,
      rate,
      pitch,
      useApplicationAudioSession: Platform.OS !== 'web',
      voice: nativeVoice,
      onDone: () => {
        clearTimeout(timeout);
        options.signal?.removeEventListener('abort', abortListener);
        LogService.info('TTS', '[Native] Speech completed');
        resolve();
      },
      onStopped: () => {
        clearTimeout(timeout);
        options.signal?.removeEventListener('abort', abortListener);
        LogService.warn('TTS', '[Native] Speech stopped');
        resolve();
      },
      onError: (error) => {
        clearTimeout(timeout);
        options.signal?.removeEventListener('abort', abortListener);
        LogService.error('TTS', `[Native] Speech error: ${error}`);
        reject(new Error(`Native TTS error: ${error}`));
      },
    });
  });
}
