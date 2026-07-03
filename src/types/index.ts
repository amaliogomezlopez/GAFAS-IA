export type AppState = 'idle' | 'listening' | 'processing' | 'speaking' | 'error';
export type ConnectionStatus = 'connected' | 'connecting' | 'disconnected';
export type LLMProvider = 'hermes' | 'openai' | 'anthropic' | 'google' | 'minimax' | 'opencode' | 'nvidia';
export type TTSProvider = 'openai' | 'elevenlabs' | 'minimax' | 'native' | 'server' | 'kokoro';
export type ResponseStyle = 'instant' | 'balanced' | 'natural';
/** Which voice pipeline the app uses for the primary talk button. */
export type VoiceMode = 'pipeline' | 'grok';

export interface GrokVoice {
  id: string;
  name: string;
}

export interface UserProfile {
  name: string;
  birthday: string; // ISO date string YYYY-MM-DD
  photoUri: string | null;
}

export interface ConversationMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: number;
  audioUri?: string;
  duration?: number;
}

export interface ConversationEntry {
  id: string;
  userMessage: ConversationMessage;
  assistantMessage: ConversationMessage;
  profileId: string;
  createdAt: number;
  sessionId?: string;
}

export interface ChatSession {
  id: string;
  name: string;
  entries: ConversationEntry[];
  createdAt: number;
  updatedAt: number;
}

export interface AIProfile {
  id: string;
  name: string;
  icon: string;
  systemPrompt: string;
  llmProvider: LLMProvider;
  llmModel: string;
  ttsProvider: TTSProvider;
  ttsVoice: string;
}

export interface LLMModel {
  id: string;
  name: string;
  provider: LLMProvider;
}

export interface TTSVoice {
  id: string;
  name: string;
  provider: TTSProvider;
  language: string;
}

export interface APIKeys {
  openai?: string;
  anthropic?: string;
  elevenlabs?: string;
  google?: string;
  minimax?: string;
  opencode?: string;
  nvidia?: string;
  minimaxGroupId?: string;
}

export interface MiniMaxConfig {
  apiKey: string;
  groupId: string;
}

export interface AppSettings {
  selectedProfileId: string;
  llmProvider: LLMProvider;
  llmModel: string;
  ttsProvider: TTSProvider;
  ttsVoice: string;
  ttsNativeVoiceId: string;
  ttsLanguage: string;
  ttsRate: number;
  ttsPitch: number;
  systemPrompt: string;
  responseStyle: ResponseStyle;
  /** Voice pipeline used by the primary talk button. */
  voiceMode: VoiceMode;
  /** Selected Grok native voice id when voiceMode === 'grok'. */
  grokVoiceId: string;
  silenceThresholdMs: number;
  finalSilenceThresholdMs: number;
  maxRecordingDurationMs: number;
  wakeWordCooldownMs: number;
  wakeWordResumeDelayMs: number;
  wakeWordMinTriggerIntervalMs: number;
  sttRetryDelayMs: number;
  sttStopTimeoutMs: number;
  llmRequestTimeoutMs: number;
  streamingEnabled: boolean;
  ttsChunkedPlaybackEnabled: boolean;
  minimaxGroupId: string;
  wakeWord: string;
  wakeWordLang: string;
  personalityId: string;
  continuousConversation: boolean;
  interruptSpeechWithButton: boolean;
  interruptSpeechWithWakeWord: boolean;
  autoConnectBluetooth: boolean;
  autoScanBluetoothOnLaunch: boolean;
  bluetoothAutoScanDurationMs: number;
  bluetoothAutoReconnectIntervalMs: number;
  speechDebugAudioEnabled: boolean;
}
