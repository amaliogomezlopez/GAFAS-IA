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

/**
 * Bump when a new one-shot settings migration is added. Migrations for older
 * versions only run once, so later user choices (e.g. picking OpenCode or a
 * shorter LLM timeout) are no longer overwritten on every launch.
 */
export const SETTINGS_SCHEMA_VERSION = 2;

export type LatencyMetrics = { sttMs?: number; llmMs?: number; ttsMs?: number; totalMs?: number };

interface StoreState {
  pipelineState: AppState;
  currentTranscription: string;
  interimTranscription: string;
  currentResponse: string;
  error: string | null;
  chatSessions: ChatSession[];
  activeSessionId: string | null;
  settings: AppSettings;
  settingsLoaded: boolean;
  isBluetoothConnected: boolean;
  bluetoothDeviceName: string | null;
  bluetoothBattery: number | null;
  userProfile: UserProfile;
  latencyMetrics: LatencyMetrics | null;
  setPipelineState: (state: AppState) => void;
  setTranscription: (text: string) => void;
  setInterimTranscription: (text: string) => void;
  setResponse: (text: string) => void;
  setError: (error: string | null) => void;
  clearError: () => void;
  addConversationEntry: (entry: ConversationEntry) => void;
  clearHistory: () => void;
  updateSettings: (partial: Partial<AppSettings>) => void;
  resetSettings: () => void;
  loadSettings: () => Promise<void>;
  setBluetoothStatus: (connected: boolean, deviceName?: string | null, battery?: number | null) => void;
  updateUserProfile: (partial: Partial<UserProfile>) => void;
  loadUserProfile: () => Promise<void>;
  setLatencyMetrics: (metrics: LatencyMetrics) => void;
  // Session management
  createSession: (name?: string) => string;
  /** Switch the Home chat to an existing session, or to a fresh one with `null`. */
  setActiveSession: (sessionId: string | null) => void;
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

let idCounter = 0;
function uniqueId(prefix: string): string {
  idCounter = (idCounter + 1) % 1_000_000;
  return `${prefix}_${Date.now()}_${idCounter}`;
}

function defaultSessionName(): string {
  const now = new Date();
  const date = now.toLocaleDateString('es-ES', { day: '2-digit', month: 'short' });
  const time = now.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
  return `Chat ${date} · ${time}`;
}

/** Applies the legacy (pre-versioned) migrations exactly once. */
function migrateSettings(parsed: Partial<AppSettings>): { settings: AppSettings; changed: boolean } {
  const merged: AppSettings = { ...DEFAULT_SETTINGS, ...parsed };
  const storedVersion = typeof parsed.settingsVersion === 'number' ? parsed.settingsVersion : 0;
  let changed = false;

  if (storedVersion < 2) {
    if (parsed.wakeWord && LEGACY_WAKE_WORDS.has(parsed.wakeWord.toLowerCase())) {
      merged.wakeWord = DEFAULT_SETTINGS.wakeWord;
      merged.wakeWordLang = DEFAULT_SETTINGS.wakeWordLang;
    }
    if (parsed.personalityId && LEGACY_PERSONALITY_IDS.has(parsed.personalityId.toLowerCase())) {
      merged.personalityId = DEFAULT_SETTINGS.personalityId;
      merged.systemPrompt = DEFAULT_SETTINGS.systemPrompt;
    }
    if (parsed.llmProvider === 'opencode' && parsed.llmModel && SLOW_OPENCODE_MODELS.has(parsed.llmModel)) {
      merged.llmModel = DEFAULT_SETTINGS.llmModel;
    }
    if (parsed.llmProvider === 'opencode' && parsed.llmModel && PRE_HERMES_DEFAULT_MODELS.has(parsed.llmModel)) {
      merged.llmProvider = DEFAULT_SETTINGS.llmProvider;
      merged.llmModel = DEFAULT_SETTINGS.llmModel;
      merged.systemPrompt = DEFAULT_SETTINGS.systemPrompt;
    }
    if (
      parsed.llmProvider === 'hermes' &&
      parsed.llmModel &&
      (PRE_OPENCODE_GO_HERMES_MODELS.has(parsed.llmModel) || PRE_DEEPSEEK_FLASH_DEFAULT_MODELS.has(parsed.llmModel))
    ) {
      merged.llmModel = DEFAULT_SETTINGS.llmModel;
    }
    if (typeof parsed.llmRequestTimeoutMs !== 'number' || parsed.llmRequestTimeoutMs < DEFAULT_SETTINGS.llmRequestTimeoutMs) {
      merged.llmRequestTimeoutMs = DEFAULT_SETTINGS.llmRequestTimeoutMs;
    }
    merged.settingsVersion = SETTINGS_SCHEMA_VERSION;
    changed = true;
  }

  // Shape repairs: cheap, idempotent, and only touch invalid values.
  if (typeof merged.streamingEnabled !== 'boolean') {
    merged.streamingEnabled = DEFAULT_SETTINGS.streamingEnabled;
    changed = true;
  }
  if (typeof merged.ttsChunkedPlaybackEnabled !== 'boolean') {
    merged.ttsChunkedPlaybackEnabled = DEFAULT_SETTINGS.ttsChunkedPlaybackEnabled;
    changed = true;
  }
  if (merged.voiceMode !== 'pipeline' && merged.voiceMode !== 'grok') {
    merged.voiceMode = DEFAULT_SETTINGS.voiceMode;
    merged.grokVoiceId = DEFAULT_SETTINGS.grokVoiceId;
    changed = true;
  }
  if (!merged.wakeWord || !merged.wakeWord.trim()) {
    merged.wakeWord = DEFAULT_SETTINGS.wakeWord;
    changed = true;
  }

  return { settings: merged, changed };
}

function persistSettings(settings: AppSettings): void {
  AsyncStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings)).catch(
    (err) => console.warn('[Store] Failed to save settings:', err),
  );
}

export const useAppStore = create<StoreState>((set, get) => ({
  // Pipeline state
  pipelineState: 'idle',
  currentTranscription: '',
  interimTranscription: '',
  currentResponse: '',
  error: null,

  // Conversation history
  chatSessions: [],
  activeSessionId: null,

  // Settings
  settings: { ...DEFAULT_SETTINGS },
  settingsLoaded: false,

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
    // Auto-create a session if none is active (or the active one was deleted)
    let sessionId = activeSessionId;
    if (!sessionId || !chatSessions.some((s) => s.id === sessionId)) {
      sessionId = createSession();
    }
    const taggedEntry = { ...entry, sessionId };

    set((state) => ({
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

  clearHistory: () => {
    set({
      chatSessions: [],
      activeSessionId: null,
      currentTranscription: '',
      currentResponse: '',
      interimTranscription: '',
    });
    get().persistSessions();
  },

  updateSettings: (partial: Partial<AppSettings>) => {
    set((state) => ({
      settings: { ...state.settings, ...partial },
    }));
    persistSettings(get().settings);
  },

  resetSettings: () => {
    const settings = { ...DEFAULT_SETTINGS };
    set({ settings });
    persistSettings(settings);
  },

  loadSettings: async () => {
    try {
      const raw = await AsyncStorage.getItem(SETTINGS_STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as Partial<AppSettings>;
        const { settings, changed } = migrateSettings(parsed);
        if (changed) persistSettings(settings);
        set({ settings });
      }
    } catch (err) {
      console.warn('[Store] Failed to load settings:', err);
    } finally {
      set({ settingsLoaded: true });
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
    const id = uniqueId('session');
    const session: ChatSession = {
      id,
      name: name || defaultSessionName(),
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

  setActiveSession: (sessionId: string | null) => {
    set({
      activeSessionId: sessionId,
      currentTranscription: '',
      currentResponse: '',
      interimTranscription: '',
      error: null,
    });
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
    set((state) => ({
      chatSessions: state.chatSessions.filter((s) => s.id !== sessionId),
      activeSessionId: state.activeSessionId === sessionId ? null : state.activeSessionId,
    }));
    get().persistSessions();
  },

  deleteEntry: (entryId: string) => {
    set((state) => ({
      chatSessions: state.chatSessions.map((s) =>
        s.entries.some((e) => e.id === entryId)
          ? { ...s, entries: s.entries.filter((e) => e.id !== entryId), updatedAt: Date.now() }
          : s,
      ),
    }));
    get().persistSessions();
  },

  loadSessions: async () => {
    try {
      const raw = await AsyncStorage.getItem(SESSIONS_STORAGE_KEY);
      if (raw) {
        const stored: ChatSession[] = JSON.parse(raw);
        if (!Array.isArray(stored)) return;
        // Merge with anything created before the async load finished.
        set((state) => {
          const knownIds = new Set(state.chatSessions.map((s) => s.id));
          return { chatSessions: [...state.chatSessions, ...stored.filter((s) => s?.id && !knownIds.has(s.id))] };
        });
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
