import { Platform } from 'react-native';
import { AIProfile, GrokVoice, LLMModel, ResponseStyle, TTSVoice } from '../types';

/* ─── KAIRO HUD Design System ──────────────────────────────── */
export const COLORS = {
  // Core palette
  primary: '#00D4FF',       // Arc reactor cyan
  primaryLight: '#5FE3FF',
  primaryDark: '#0099CC',
  onPrimary: '#03121A',     // Text/icons on a solid primary surface
  accent: '#FF8A3D',        // Warm orange for highlights
  accentLight: '#FFAB73',
  // Surfaces (from deepest to most raised)
  background: '#05080F',
  card: '#0B121D',
  surface: '#101A28',
  surfaceLight: '#162233',
  surfaceRaised: '#1B2A3E',
  border: '#1C2B40',
  borderLight: '#2A4060',
  overlay: 'rgba(2, 5, 10, 0.72)',
  // Text
  text: '#E8F0FF',
  textSecondary: '#8B9DB5',
  textMuted: '#55697F',
  // Semantic
  success: '#2EE59D',
  warning: '#FFB800',
  error: '#FF4D6A',
  // Pipeline states
  listening: '#00D4FF',
  processing: '#FFB800',
  speaking: '#2EE59D',
};

/** `#RRGGBB` + alpha (0–1) → `#RRGGBBAA`. Keeps tinted surfaces readable. */
export function withAlpha(hex: string, alpha: number): string {
  const clamped = Math.max(0, Math.min(1, alpha));
  return `${hex}${Math.round(clamped * 255).toString(16).padStart(2, '0')}`;
}

export const SPACING = {
  xs: 4,
  sm: 8,
  md: 16,
  lg: 24,
  xl: 32,
  xxl: 48,
};

export const RADIUS = {
  sm: 8,
  md: 12,
  lg: 16,
  xl: 22,
  pill: 999,
};

export const FONT_SIZE = {
  xs: 10,
  sm: 12,
  md: 14,
  lg: 16,
  xl: 20,
  xxl: 24,
  xxxl: 32,
};

/** Monospace face for logs and technical values. */
export const MONO_FONT = Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' });

export const LLM_MODELS: LLMModel[] = [
  { id: 'deepseek-v4-flash', name: 'Hermes / DeepSeek V4 Flash', provider: 'hermes' },
  { id: 'kimi-k2.6', name: 'Hermes / Kimi K2.6', provider: 'hermes' },
  { id: 'kimi-k2.5', name: 'Hermes / Kimi K2.5', provider: 'hermes' },
  { id: 'deepseek-v4-pro', name: 'Hermes / DeepSeek V4 Pro', provider: 'hermes' },
  { id: 'glm-5.1', name: 'Hermes / GLM-5.1', provider: 'hermes' },
  { id: 'glm-5', name: 'Hermes / GLM-5', provider: 'hermes' },
  { id: 'mimo-v2.5-pro', name: 'Hermes / MiMo V2.5 Pro', provider: 'hermes' },
  { id: 'mimo-v2.5', name: 'Hermes / MiMo V2.5', provider: 'hermes' },
  { id: 'mimo-v2-pro', name: 'Hermes / MiMo V2 Pro', provider: 'hermes' },
  { id: 'mimo-v2-omni', name: 'Hermes / MiMo V2 Omni', provider: 'hermes' },
  { id: 'minimax-m2.7', name: 'Hermes / MiniMax M2.7', provider: 'hermes' },
  { id: 'minimax-m2.5', name: 'Hermes / MiniMax M2.5', provider: 'hermes' },
  { id: 'qwen3.6-plus', name: 'Hermes / Qwen3.6 Plus', provider: 'hermes' },
  { id: 'qwen3.5-plus', name: 'Hermes / Qwen3.5 Plus', provider: 'hermes' },
  { id: 'hermes-agent', name: 'Hermes / modelo actual', provider: 'hermes' },
  { id: 'gpt-4o', name: 'GPT-4o', provider: 'openai' },
  { id: 'gpt-4o-mini', name: 'GPT-4o Mini', provider: 'openai' },
  { id: 'gpt-4-turbo', name: 'GPT-4 Turbo', provider: 'openai' },
  { id: 'claude-3-5-sonnet-20241022', name: 'Claude 3.5 Sonnet', provider: 'anthropic' },
  { id: 'claude-3-haiku-20240307', name: 'Claude 3 Haiku', provider: 'anthropic' },
  { id: 'gemini-1.5-pro', name: 'Gemini 1.5 Pro', provider: 'google' },
  { id: 'gemini-1.5-flash', name: 'Gemini 1.5 Flash', provider: 'google' },
  { id: 'MiniMax-M2.7', name: 'MiniMax M2.7', provider: 'minimax' },
  { id: 'MiniMax-M2.5', name: 'MiniMax M2.5', provider: 'minimax' },
  { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', provider: 'opencode' },
  { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', provider: 'opencode' },
  { id: 'glm-5.1', name: 'GLM-5.1', provider: 'opencode' },
  { id: 'glm-5', name: 'GLM-5', provider: 'opencode' },
  { id: 'kimi-k2.6', name: 'Kimi K2.6', provider: 'opencode' },
  { id: 'kimi-k2.5', name: 'Kimi K2.5', provider: 'opencode' },
  { id: 'mimo-v2.5-pro', name: 'MiMo V2.5 Pro', provider: 'opencode' },
  { id: 'mimo-v2.5', name: 'MiMo V2.5', provider: 'opencode' },
  { id: 'mimo-v2-pro', name: 'MiMo V2 Pro', provider: 'opencode' },
  { id: 'mimo-v2-omni', name: 'MiMo V2 Omni', provider: 'opencode' },
  { id: 'minimax-m2.7', name: 'MiniMax M2.7', provider: 'opencode' },
  { id: 'minimax-m2.5', name: 'MiniMax M2.5', provider: 'opencode' },
  { id: 'qwen3.6-plus', name: 'Qwen3.6 Plus', provider: 'opencode' },
  { id: 'qwen3.5-plus', name: 'Qwen3.5 Plus', provider: 'opencode' },
  { id: 'moonshotai/kimi-k2.6', name: 'Kimi K2.6 (NVIDIA)', provider: 'nvidia' },
  { id: 'deepseek-ai/deepseek-v4-flash', name: 'DeepSeek V4 Flash (NVIDIA)', provider: 'nvidia' },
  { id: 'nvidia/nemotron-3-super-120b-a12b', name: 'Nemotron 3 Super 120B', provider: 'nvidia' },
  { id: 'minimaxai/minimax-m2.7', name: 'MiniMax M2.7 (NVIDIA)', provider: 'nvidia' },
];

export const TTS_VOICES: TTSVoice[] = [
  { id: 'alloy', name: 'Alloy', provider: 'openai', language: 'multi' },
  { id: 'echo', name: 'Echo', provider: 'openai', language: 'multi' },
  { id: 'fable', name: 'Fable', provider: 'openai', language: 'multi' },
  { id: 'onyx', name: 'Onyx', provider: 'openai', language: 'multi' },
  { id: 'nova', name: 'Nova', provider: 'openai', language: 'multi' },
  { id: 'shimmer', name: 'Shimmer', provider: 'openai', language: 'multi' },
  { id: 'rachel', name: 'Rachel', provider: 'elevenlabs', language: 'en' },
  { id: 'male-qn-qingse', name: 'Qingse (Joven)', provider: 'minimax', language: 'multi' },
  { id: 'male-qn-jingying', name: 'Jingying (Élite)', provider: 'minimax', language: 'multi' },
  { id: 'female-shaonv', name: 'Shaonv (Chica)', provider: 'minimax', language: 'multi' },
  { id: 'female-yujie', name: 'Yujie (Madura)', provider: 'minimax', language: 'multi' },
  { id: 'presenter_male', name: 'Presentador', provider: 'minimax', language: 'multi' },
  { id: 'presenter_female', name: 'Presentadora', provider: 'minimax', language: 'multi' },
  { id: 'native-ios', name: 'iOS Español', provider: 'native', language: 'es' },
  { id: 'native-en', name: 'iOS English', provider: 'native', language: 'en' },
  { id: 'native-mx', name: 'iOS México', provider: 'native', language: 'es-MX' },
  // Server voices (Edge TTS via proxy — high quality neural voices)
  { id: 'es-ES-AlvaroNeural', name: 'Álvaro (España)', provider: 'server', language: 'es' },
  { id: 'es-ES-ElviraNeural', name: 'Elvira (España)', provider: 'server', language: 'es' },
  { id: 'es-MX-DaliaNeural', name: 'Dalia (México)', provider: 'server', language: 'es' },
  { id: 'es-MX-JorgeNeural', name: 'Jorge (México)', provider: 'server', language: 'es' },
  { id: 'en-US-GuyNeural', name: 'Guy (English)', provider: 'server', language: 'en' },
  { id: 'en-US-JennyNeural', name: 'Jenny (English)', provider: 'server', language: 'en' },
  // Kokoro voices (optional local/server TTS via proxy)
  { id: 'ef_dora', name: 'Dora (Kokoro ES)', provider: 'kokoro', language: 'es' },
  { id: 'em_alex', name: 'Alex (Kokoro ES)', provider: 'kokoro', language: 'es' },
  { id: 'em_santa', name: 'Santa (Kokoro ES)', provider: 'kokoro', language: 'es' },
];

/**
 * Native Grok voices available through the xAI Realtime Voice Agent API.
 * Used only when voiceMode === 'grok'. These are the voice ids passed to the
 * realtime session.update event. Spanish (es-ES) is fully supported by all of them.
 */
export const GROK_VOICES: GrokVoice[] = [
  { id: 'eve', name: 'Eve (cálida)' },
  { id: 'ara', name: 'Ara (suave)' },
  { id: 'rex', name: 'Rex (grave)' },
  { id: 'sal', name: 'Sal (serena)' },
  { id: 'leo', name: 'Leo (energética)' },
];

export const WAKE_WORD_PRESETS = [
  { id: 'kairo', label: 'KAIRO', phrase: 'KAIRO', lang: 'es-ES' },
  { id: 'custom', label: 'Personalizado...', phrase: '', lang: 'es-ES' },
];

export const DEFAULT_PROFILES: AIProfile[] = [
  {
    id: 'assistant',
    name: 'KAIRO',
    icon: 'robot',
    systemPrompt: 'Eres KAIRO, el asistente de voz de unas gafas inteligentes conectado a HERMES mediante el proxy configurado. Usa las herramientas de Hermes cuando el usuario pida acciones, tareas, busquedas, archivos o automatizaciones. Responde de forma concisa, clara y util en el idioma del usuario.',
    llmProvider: 'hermes',
    llmModel: 'deepseek-v4-flash',
    ttsProvider: 'native',
    ttsVoice: 'native-ios',
  },
  {
    id: 'translator',
    name: 'Traductor',
    icon: 'translate',
    systemPrompt: 'Eres un traductor profesional. El usuario te hablará en un idioma y tú debes traducir al inglés. Si te habla en inglés, traduce al español. Solo devuelve la traducción, sin explicaciones.',
    llmProvider: 'minimax',
    llmModel: 'MiniMax-M2.7',
    ttsProvider: 'native',
    ttsVoice: 'native-ios',
  },
  {
    id: 'expert',
    name: 'Experto',
    icon: 'school',
    systemPrompt: 'Eres un experto en todos los campos. Proporciona respuestas detalladas y bien fundamentadas. Si no sabes algo, dilo claramente. Responde en el idioma del usuario.',
    llmProvider: 'minimax',
    llmModel: 'MiniMax-M2.7',
    ttsProvider: 'native',
    ttsVoice: 'native-ios',
  },
  {
    id: 'concise',
    name: 'Conciso',
    icon: 'flash',
    systemPrompt: 'Responde en una sola frase corta. Máximo 20 palabras. Sé directo y útil.',
    llmProvider: 'minimax',
    llmModel: 'MiniMax-M2.7',
    ttsProvider: 'native',
    ttsVoice: 'native-ios',
  },
];

/* ─── AI Personality Presets ───────────────────────────────── */
export interface PersonalityPreset {
  id: string;
  name: string;
  icon: string;
  description: string;
  systemPromptPrefix: string;
}

export const PERSONALITY_PRESETS: PersonalityPreset[] = [
  {
    id: 'kairo',
    name: 'KAIRO',
    icon: 'shield-half-full',
    description: 'Identidad principal de las gafas',
    systemPromptPrefix: 'Eres KAIRO, el asistente de voz de unas gafas inteligentes conectado a HERMES mediante el proxy configurado. Responde en voz alta con frases breves, utiles y naturales. Usa herramientas de Hermes cuando el usuario pida acciones, tareas, busquedas, archivos o automatizaciones. Tutea al usuario con educacion y evita mencionar tu palabra de activacion salvo que te pregunten por ella.',
  },
  {
    id: 'neutral',
    name: 'Neutral',
    icon: 'robot-outline',
    description: 'Asistente directo y funcional',
    systemPromptPrefix: 'Eres un asistente inteligente. Responde de forma concisa y útil en español.',
  },
  {
    id: 'friendly',
    name: 'Amigable',
    icon: 'emoticon-happy-outline',
    description: 'Cercano, cálido y motivador',
    systemPromptPrefix: 'Eres un asistente amigable y cercano. Responde con entusiasmo y positividad. Usa un tono cálido e informal. Tutea al usuario.',
  },
  {
    id: 'technical',
    name: 'Técnico',
    icon: 'code-tags',
    description: 'Preciso y orientado a datos',
    systemPromptPrefix: 'Eres un asistente técnico y preciso. Incluye datos concretos, explica causas y efectos, y evita ambigüedades. Sé directo.',
  },
];

export const RESPONSE_STYLE_PRESETS: Array<{
  id: ResponseStyle;
  name: string;
  description: string;
  silenceThresholdMs: number;
  finalSilenceThresholdMs: number;
  ttsRate: number;
  maxTokens: number;
}> = [
  {
    id: 'instant',
    name: 'Ultra-rápido',
    description: 'Respuestas de una frase y arranque agresivo para latencia sub-segundo.',
    silenceThresholdMs: 1100,
    finalSilenceThresholdMs: 300,
    ttsRate: 1.12,
    maxTokens: 96,
  },
  {
    id: 'balanced',
    name: 'Equilibrado',
    description: 'Buen balance entre rapidez y naturalidad.',
    silenceThresholdMs: 1300,
    finalSilenceThresholdMs: 380,
    ttsRate: 1.08,
    maxTokens: 320,
  },
  {
    id: 'natural',
    name: 'Natural',
    description: 'Más pausado y expresivo, con respuestas algo más desarrolladas.',
    silenceThresholdMs: 1700,
    finalSilenceThresholdMs: 500,
    ttsRate: 1.0,
    maxTokens: 640,
  },
];

export const RESPONSE_STYLE_LABELS: Record<ResponseStyle, string> = {
  instant: 'Ultra-rápido',
  balanced: 'Equilibrado',
  natural: 'Natural',
};

export const DEFAULT_SETTINGS = {
  selectedProfileId: 'assistant',
  llmProvider: 'hermes' as const,
  llmModel: 'deepseek-v4-flash',
  ttsProvider: 'native' as const,
  ttsVoice: 'native-ios',
  ttsNativeVoiceId: '',
  ttsLanguage: 'es',
  ttsRate: 1.12,
  ttsPitch: 1.0,
  systemPrompt: 'Eres KAIRO, el asistente de voz de unas gafas inteligentes conectado a HERMES mediante el proxy configurado. Puedes usar herramientas de Hermes como web, navegador, terminal, archivos, memoria, TODO y cron cuando el usuario pida acciones o tareas. Para voz, responde breve y confirma solo lo importante.',
  responseStyle: 'instant' as const,
  voiceMode: 'pipeline' as const,
  grokVoiceId: 'eve',
  silenceThresholdMs: 1100,
  finalSilenceThresholdMs: 300,
  maxRecordingDurationMs: 30000,
  wakeWordCooldownMs: 450,
  wakeWordResumeDelayMs: 90,
  wakeWordMinTriggerIntervalMs: 1200,
  sttRetryDelayMs: 80,
  sttStopTimeoutMs: 1300,
  llmRequestTimeoutMs: 90000,
  streamingEnabled: true,
  ttsChunkedPlaybackEnabled: true,
  minimaxGroupId: '',
  wakeWord: 'KAIRO',
  wakeWordLang: 'es-ES',
  personalityId: 'kairo',
  continuousConversation: true,
  interruptSpeechWithButton: true,
  interruptSpeechWithWakeWord: true,
  autoConnectBluetooth: true,
  autoScanBluetoothOnLaunch: true,
  bluetoothAutoScanDurationMs: 2500,
  bluetoothAutoReconnectIntervalMs: 7000,
  speechDebugAudioEnabled: true,
  settingsVersion: 2,
};

/** Proxy server configuration — keeps API keys server-side */
export const PROXY_CONFIG = {
  baseUrl: process.env.EXPO_PUBLIC_PROXY_BASE_URL || '',
  appToken: process.env.EXPO_PUBLIC_PROXY_APP_TOKEN || '',
};

const OPENCODE_BASE_URL = process.env.EXPO_PUBLIC_OPENCODE_BASE_URL || 'https://opencode.ai/zen/go/v1';
const NVIDIA_BASE_URL = process.env.EXPO_PUBLIC_NVIDIA_BASE_URL || 'https://integrate.api.nvidia.com/v1';

export const API_ENDPOINTS = {
  openai: {
    stt: 'https://api.openai.com/v1/audio/transcriptions',
    chat: 'https://api.openai.com/v1/chat/completions',
    tts: 'https://api.openai.com/v1/audio/speech',
  },
  anthropic: {
    chat: 'https://api.anthropic.com/v1/messages',
  },
  elevenlabs: {
    tts: 'https://api.elevenlabs.io/v1/text-to-speech',
  },
  minimax: {
    chat: 'https://api.minimax.io/anthropic/v1/messages',
    tts: 'https://api.minimaxi.com/v1/t2a_v2',
  },
  opencode: {
    baseUrl: OPENCODE_BASE_URL,
    chat: `${OPENCODE_BASE_URL}/chat/completions`,
    messages: `${OPENCODE_BASE_URL}/messages`,
    models: `${OPENCODE_BASE_URL}/models`,
  },
  nvidia: {
    baseUrl: NVIDIA_BASE_URL,
    chat: `${NVIDIA_BASE_URL}/chat/completions`,
    models: `${NVIDIA_BASE_URL}/models`,
  },
  proxy: {
    health: `${PROXY_CONFIG.baseUrl}/health`,
    authPair: `${PROXY_CONFIG.baseUrl}/api/v1/auth/pair`,
    authStatus: `${PROXY_CONFIG.baseUrl}/api/v1/auth/status`,
    authRevokeSelf: `${PROXY_CONFIG.baseUrl}/api/v1/auth/revoke-self`,
    chat: `${PROXY_CONFIG.baseUrl}/api/v1/chat`,
    hermesHealth: `${PROXY_CONFIG.baseUrl}/api/v1/hermes/health`,
    hermesStatus: `${PROXY_CONFIG.baseUrl}/api/v1/hermes/status`,
    hermesModel: `${PROXY_CONFIG.baseUrl}/api/v1/hermes/model`,
    hermesCapabilities: `${PROXY_CONFIG.baseUrl}/api/v1/hermes/capabilities`,
    hermesChat: `${PROXY_CONFIG.baseUrl}/api/v1/hermes/chat/completions`,
    hermesResponses: `${PROXY_CONFIG.baseUrl}/api/v1/hermes/responses`,
    hermesJobs: `${PROXY_CONFIG.baseUrl}/api/v1/hermes/jobs`,
    opencodeChat: `${PROXY_CONFIG.baseUrl}/api/v1/opencode/chat/completions`,
    opencodeMessages: `${PROXY_CONFIG.baseUrl}/api/v1/opencode/messages`,
    tts: `${PROXY_CONFIG.baseUrl}/api/v1/tts`,
    ttsEdge: `${PROXY_CONFIG.baseUrl}/api/v1/tts/edge`,
    ttsKokoro: `${PROXY_CONFIG.baseUrl}/api/v1/tts/kokoro`,
    ttsKokoroStream: `${PROXY_CONFIG.baseUrl}/api/v1/tts/kokoro/stream`,
    xaiRealtimeSession: `${PROXY_CONFIG.baseUrl}/api/v1/xai/realtime/session`,
  },
};
