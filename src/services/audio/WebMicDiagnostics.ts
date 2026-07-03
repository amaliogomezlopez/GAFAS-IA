import { Platform } from 'react-native';
import { LogService } from '../LogService';

type WebAudioContext = AudioContext & { webkitAudioContext?: typeof AudioContext };

let stream: MediaStream | null = null;
let audioContext: AudioContext | null = null;
let analyser: AnalyserNode | null = null;
let source: MediaStreamAudioSourceNode | null = null;
let sampleBuffer: Uint8Array<ArrayBuffer> | null = null;
let meterTimer: ReturnType<typeof setInterval> | null = null;
let startedAt = 0;
let maxRms = 0;
let maxPeak = 0;
let audibleFrames = 0;
let totalFrames = 0;
let lastActiveLogAt = 0;
let lastSummary: {
  durationMs: number;
  maxRms: number;
  maxPeak: number;
  audibleRatio: number;
} | null = null;

function isWeb(): boolean {
  return Platform.OS === 'web';
}

function getMediaDevices(): MediaDevices | null {
  if (!isWeb()) return null;
  return (globalThis.navigator as Navigator | undefined)?.mediaDevices ?? null;
}

function getAudioContextClass(): typeof AudioContext | null {
  const globalObject = globalThis as typeof globalThis & {
    AudioContext?: typeof AudioContext;
    webkitAudioContext?: typeof AudioContext;
  };
  return globalObject.AudioContext ?? globalObject.webkitAudioContext ?? null;
}

function summarizeDevice(device: MediaDeviceInfo, index: number): string {
  const label = device.label || `entrada ${index + 1} sin nombre`;
  return `${label} (${device.deviceId === 'default' ? 'default' : device.deviceId.slice(0, 8)})`;
}

async function logInputDevices(mediaDevices: MediaDevices): Promise<void> {
  try {
    const devices = await mediaDevices.enumerateDevices();
    const inputs = devices.filter((device) => device.kind === 'audioinput');
    if (!inputs.length) {
      LogService.warn('Mic', 'Chrome no lista entradas de audio');
      return;
    }
    LogService.info('Mic', `Entradas de audio visibles: ${inputs.map(summarizeDevice).join(' | ')}`);
  } catch (error) {
    LogService.warn('Mic', `No se pudieron listar micrófonos: ${error}`);
  }
}

function readLevels(): void {
  if (!analyser || !sampleBuffer) return;

  analyser.getByteTimeDomainData(sampleBuffer);

  let sumSquares = 0;
  let peak = 0;
  for (const sample of sampleBuffer) {
    const centered = (sample - 128) / 128;
    const abs = Math.abs(centered);
    sumSquares += centered * centered;
    if (abs > peak) peak = abs;
  }

  const rms = Math.sqrt(sumSquares / sampleBuffer.length);
  maxRms = Math.max(maxRms, rms);
  maxPeak = Math.max(maxPeak, peak);
  totalFrames += 1;

  if (rms > 0.012 || peak > 0.08) {
    audibleFrames += 1;
    const now = Date.now();
    if (now - lastActiveLogAt > 2200) {
      lastActiveLogAt = now;
      LogService.info('Mic', `Señal de micro detectada (rms=${rms.toFixed(3)}, peak=${peak.toFixed(3)})`);
    }
  }
}

export const WebMicDiagnostics = {
  async start(label: string = 'stt'): Promise<void> {
    if (!isWeb()) return;
    await this.stop();

    const mediaDevices = getMediaDevices();
    if (!mediaDevices?.getUserMedia) {
      LogService.warn('Mic', 'getUserMedia no está disponible en este navegador');
      return;
    }

    const AudioContextClass = getAudioContextClass();
    if (!AudioContextClass) {
      LogService.warn('Mic', 'WebAudio no está disponible; no se puede medir el nivel del micro');
      return;
    }

    try {
      stream = await mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });

      const track = stream.getAudioTracks()[0];
      LogService.info('Mic', `getUserMedia activo (${label}): ${track?.label || 'micrófono sin etiqueta'}`);
      await logInputDevices(mediaDevices);

      audioContext = new AudioContextClass() as WebAudioContext;
      source = audioContext.createMediaStreamSource(stream);
      analyser = audioContext.createAnalyser();
      analyser.fftSize = 1024;
      sampleBuffer = new Uint8Array(new ArrayBuffer(analyser.fftSize));
      source.connect(analyser);

      startedAt = Date.now();
      maxRms = 0;
      maxPeak = 0;
      audibleFrames = 0;
      totalFrames = 0;
      lastActiveLogAt = 0;
      meterTimer = setInterval(readLevels, 350);
    } catch (error) {
      LogService.error('Mic', `No se pudo abrir el micrófono de Chrome: ${error}`);
    }
  },

  async stop(): Promise<void> {
    if (meterTimer) {
      clearInterval(meterTimer);
      meterTimer = null;
    }

    const durationMs = startedAt ? Date.now() - startedAt : 0;
    if (durationMs > 0) {
      const audibleRatio = totalFrames > 0 ? audibleFrames / totalFrames : 0;
      lastSummary = { durationMs, maxRms, maxPeak, audibleRatio };
      const summary = `Resumen micro: ${durationMs}ms, maxRms=${maxRms.toFixed(3)}, maxPeak=${maxPeak.toFixed(3)}, audible=${Math.round(audibleRatio * 100)}%`;
      if (maxRms < 0.006 && maxPeak < 0.04) {
        LogService.warn('Mic', `${summary}. Chrome casi no recibió señal de entrada.`);
      } else {
        LogService.info('Mic', summary);
      }
    }

    try {
      source?.disconnect();
    } catch {}
    source = null;
    analyser = null;
    sampleBuffer = null;

    if (audioContext) {
      try {
        await audioContext.close();
      } catch {}
      audioContext = null;
    }

    stream?.getTracks().forEach((track) => {
      try {
        track.stop();
      } catch {}
    });
    stream = null;
    startedAt = 0;
  },

  getLastSummary(): typeof lastSummary {
    return lastSummary;
  },
};
