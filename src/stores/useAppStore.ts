import { create } from 'zustand';
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { AppState, ConversationEntry, AppSettings, UserProfile, ChatSession } from '../types';
import { DEFAULT_SETTINGS } from '../constants';

const PROFILE_STORAGE_KEY = '@smartglasses_user_profile';
const SESSIONS_STORAGE_KEY = '@smartglasses_chat_sessions';
const SETTINGS_STORAGE_KEY = '@smartglasses_settings';
const LEGACY_WAKE_WORDS = new Set(['aimbi', 'aimb', 'hola gafas', 'oye gafas', 'hola aimb', 'oye aimb s1']);
const LEGACY_PERSONALITY_IDS = new Set(['jarvis']);
const SLOW_OPENCODE_MODELS = new Set(['glm-5.1', 'glm-5']);
const PRE_HERMES_DEFAULT_MODELS = new Set(['deepseek-v4-flash']);
const PRE_OPENCODE_GO_HERMES_MODELS = new Set(['hermes-agent']);
const PRE_DEEPSEEK_FLASH_DEFAULT_MODELS = new Set(['kimi-k2.6']);

interface StoreState {
  pipelineState: AppState;
  currentTranscription: string;
  interimTranscription: string;
  currentResponse: string;
  error: string | null;
  conversationHistory: ConversationEntry[];
  chatSessions: ChatSession[];
  activeSessionId: string | null;
  settings: AppSettings;
  isBluetoothConnected: boolean;
  bluetoothDeviceName: string | null;
  bluetoothBattery: number | null;
  userProfile: UserProfile;
  latencyMetrics: { sttMs?: number; llmMs?: number; ttsMs?: number; totalMs?: number } | null;
  setPipelineState: (state: AppState) => void;
  setTranscription: (text: string) => void;
  setInterimTranscription: (text: string) => void;
  setResponse: (text: string) => void;
  setError: (error: string | null) => void;
  clearError: () => void;
  addConversationEntry: (entry: ConversationEntry) => void;
  clearHistory: () => void;
  updateSettings: (partial: Partial<AppSettings>) => void;
  loadSettings: () => Promise<void>;
  setBluetoothStatus: (connected: boolean, deviceName?: string | null, battery?: number | null) => void;
  updateUserProfile: (partial: Partial<UserProfile>) => void;
  loadUserProfile: () => Promise<void>;
  setLatencyMetrics: (metrics: { sttMs?: number; llmMs?: number; ttsMs?: number; totalMs?: number }) => void;
  // Session management
  createSession: (name?: string) => string;
  renameSession: (sessionId: string, name: string) => void;
  deleteSession: (sessionId: string) => void;
  deleteEntry: (entryId: string) => void;
  loadSessions: () => Promise<void>;
  persistSessions: () => Promise<void>;
}

const DEFAULT_USER_PROFILE: UserProfile = {
  name: '',
  birthday: '',
  photoUri: null,
};

export const useAppStore = create<StoreState>((set, get) => ({
  // Pipeline state
  pipelineState: 'idle',
  currentTranscription: '',
  interimTranscription: '',
  currentResponse: '',
  error: null,

  // Conversation history
  conversationHistory: [],
  chatSessions: [],
  activeSessionId: null,

  // Settings
  settings: { ...DEFAULT_SETTINGS },

  // Bluetooth
  isBluetoothConnected: false,
  bluetoothDeviceName: null,
  bluetoothBattery: null,

  // User profile
  userProfile: { ...DEFAULT_USER_PROFILE },

  // Latency metrics
  latencyMetrics: null,

  // Actions
  setPipelineState: (state) => set({ pipelineState: state }),
  setTranscription: (text) => set({ currentTranscription: text, interimTranscription: '' }),
  setInterimTranscription: (text) => set({ interimTranscription: text }),
  setResponse: (text) => set({ currentResponse: text }),
  setError: (error) => set({ error }),
  clearError: () => set({ error: null }),

  setLatencyMetrics: (metrics) => set({ latencyMetrics: metrics }),

  addConversationEntry: (entry: ConversationEntry) => {
    const { activeSessionId, chatSessions, createSession } = get();
    // Auto-create a session if none is active
    let sessionId = activeSessionId;
    if (!sessionId) {
      sessionId = createSession();
    }
    const taggedEntry = { ...entry, sessionId };

    set((state) => ({
      conversationHistory: [taggedEntry, ...state.conversationHistory],
      chatSessions: state.chatSessions.map((s) =>
        s.id === sessionId
          ? { ...s, entries: [taggedEntry, ...s.entries], updatedAt: Date.now() }
          : s,
      ),
      // Clear current turn so UI reads from session entries
      currentTranscription: '',
      currentResponse: '',
      interimTranscription: '',
    }));
    get().persistSessions();
  },

  clearHistory: () => set({ conversationHistory: [] }),

  updateSettings: (partial: Partial<AppSettings>) => {
    set((state) => ({
      settings: { ...state.settings, ...partial },
    }));
    // Persist settings to AsyncStorage
    const updated = get().settings;
    AsyncStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(updated)).catch(
      (err) => console.warn('[Store] Failed to save settings:', err),
    );
  },

  loadSettings: async () => {
    try {
      const raw = await AsyncStorage.getItem(SETTINGS_STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as Partial<AppSettings>;
        const merged = { ...DEFAULT_SETTINGS, ...parsed };
        const needsWakeWordMigration = !!parsed.wakeWord && LEGACY_WAKE_WORDS.has(parsed.wakeWord.toLowerCase());
        const needsPersonalityMigration = !!parsed.personalityId && LEGACY_PERSONALITY_IDS.has(parsed.personalityId.toLowerCase());
        const needsModelMigration = parsed.llmProvider === 'opencode' && !!parsed.llmModel && SLOW_OPENCODE_MODELS.has(parsed.llmModel);
        const needsHermesMigration =
          parsed.llmProvider === 'opencode' &&
          !!parsed.llmModel &&
          PRE_HERMES_DEFAULT_MODELS.has(parsed.llmModel);
        const needsOpenCodeGoHermesMigration =
          parsed.llmProvider === 'hermes' &&
          !!parsed.llmModel &&
          PRE_OPENCODE_GO_HERMES_MODELS.has(parsed.llmModel);
        const needsDeepSeekFlashDefaultMigration =
          parsed.llmProvider === 'hermes' &&
          !!parsed.llmModel &&
          PRE_DEEPSEEK_FLASH_DEFAULT_MODELS.has(parsed.llmModel);
        const needsTimeoutMigration =
          typeof parsed.llmRequestTimeoutMs !== 'number' ||
          parsed.llmRequestTimeoutMs < DEFAULT_SETTINGS.llmRequestTimeoutMs;
        const needsStreamingMigration =
          typeof parsed.streamingEnabled !== 'boolean' ||
          typeof parsed.ttsChunkedPlaybackEnabled !== 'boolean';
        const needsVoiceModeMigration =
          parsed.voiceMode !== 'pipeline' && parsed.voiceMode !== 'grok';
        if (needsWakeWordMigration) {
          merged.wakeWord = DEFAULT_SETTINGS.wakeWord;
          merged.wakeWordLang = DEFAULT_SETTINGS.wakeWordLang;
        }
        if (needsPersonalityMigration) {
          merged.personalityId = DEFAULT_SETTINGS.personalityId;
          merged.systemPrompt = DEFAULT_SETTINGS.systemPrompt;
        }
        if (needsModelMigration) {
          merged.llmModel = DEFAULT_SETTINGS.llmModel;
        }
        if (needsHermesMigration) {
          merged.llmProvider = DEFAULT_SETTINGS.llmProvider;
          merged.llmModel = DEFAULT_SETTINGS.llmModel;
          merged.systemPrompt = DEFAULT_SETTINGS.systemPrompt;
        }
        if (needsOpenCodeGoHermesMigration) {
          merged.llmModel = DEFAULT_SETTINGS.llmModel;
        }
        if (needsDeepSeekFlashDefaultMigration) {
          merged.llmModel = DEFAULT_SETTINGS.llmModel;
        }
        if (needsTimeoutMigration) {
          merged.llmRequestTimeoutMs = DEFAULT_SETTINGS.llmRequestTimeoutMs;
        }
        if (needsStreamingMigration) {
          merged.streamingEnabled = DEFAULT_SETTINGS.streamingEnabled;
          merged.ttsChunkedPlaybackEnabled = DEFAULT_SETTINGS.ttsChunkedPlaybackEnabled;
        }
        if (needsVoiceModeMigration) {
          merged.voiceMode = DEFAULT_SETTINGS.voiceMode;
          merged.grokVoiceId = DEFAULT_SETTINGS.grokVoiceId;
        }
        if (
          needsWakeWordMigration ||
          needsPersonalityMigration ||
          needsModelMigration ||
          needsHermesMigration ||
          needsOpenCodeGoHermesMigration ||
          needsDeepSeekFlashDefaultMigration ||
          needsTimeoutMigration ||
          needsStreamingMigration ||
          needsVoiceModeMigration
        ) {
          AsyncStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(merged)).catch(
            (err) => console.warn('[Store] Failed to migrate settings:', err),
          );
        }
        set({ settings: merged });
      }
    } catch (err) {
      console.warn('[Store] Failed to load settings:', err);
    }
  },

  setBluetoothStatus: (connected: boolean, deviceName?: string | null, battery?: number | null) =>
    set({
      isBluetoothConnected: connected,
      bluetoothDeviceName: deviceName ?? null,
      bluetoothBattery: battery ?? null,
    }),

  updateUserProfile: (partial: Partial<UserProfile>) => {
    const updated = { ...get().userProfile, ...partial };
    set({ userProfile: updated });
    AsyncStorage.setItem(PROFILE_STORAGE_KEY, JSON.stringify(updated)).catch(
      (err) => console.warn('[Store] Failed to save profile:', err),
    );
  },

  loadUserProfile: async () => {
    try {
      const raw = await AsyncStorage.getItem(PROFILE_STORAGE_KEY);
      if (raw) {
        set({ userProfile: { ...DEFAULT_USER_PROFILE, ...JSON.parse(raw) } });
      }
    } catch (err) {
      console.warn('[Store] Failed to load profile:', err);
    }
  },

  // ── Session management ──────────────────────────────────────

  createSession: (name?: string) => {
    const id = `session_${Date.now()}`;
    const session: ChatSession = {
      id,
      name: name || `Chat ${new Date().toLocaleDateString('es-ES')}`,
      entries: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    set((state) => ({
      chatSessions: [session, ...state.chatSessions],
      activeSessionId: id,
    }));
    get().persistSessions();
    return id;
  },

  renameSession: (sessionId: string, name: string) => {
    set((state) => ({
      chatSessions: state.chatSessions.map((s) =>
        s.id === sessionId ? { ...s, name, updatedAt: Date.now() } : s,
      ),
    }));
    get().persistSessions();
  },

  deleteSession: (sessionId: string) => {
    set((state) => {
      const session = state.chatSessions.find((s) => s.id === sessionId);
      const entryIds = new Set(session?.entries.map((e) => e.id) || []);
      return {
        chatSessions: state.chatSessions.filter((s) => s.id !== sessionId),
        conversationHistory: state.conversationHistory.filter((e) => !entryIds.has(e.id)),
        activeSessionId: state.activeSessionId === sessionId ? null : state.activeSessionId,
      };
    });
    get().persistSessions();
  },

  deleteEntry: (entryId: string) => {
    set((state) => ({
      conversationHistory: state.conversationHistory.filter((e) => e.id !== entryId),
      chatSessions: state.chatSessions.map((s) => ({
        ...s,
        entries: s.entries.filter((e) => e.id !== entryId),
        updatedAt: Date.now(),
      })),
    }));
    get().persistSessions();
  },

  loadSessions: async () => {
    try {
      const raw = await AsyncStorage.getItem(SESSIONS_STORAGE_KEY);
      if (raw) {
        const sessions: ChatSession[] = JSON.parse(raw);
        set({ chatSessions: sessions });
      }
    } catch (err) {
      console.warn('[Store] Failed to load sessions:', err);
    }
  },

  persistSessions: async () => {
    try {
      await AsyncStorage.setItem(SESSIONS_STORAGE_KEY, JSON.stringify(get().chatSessions));
    } catch (err) {
      console.warn('[Store] Failed to persist sessions:', err);
    }
  },
}));
