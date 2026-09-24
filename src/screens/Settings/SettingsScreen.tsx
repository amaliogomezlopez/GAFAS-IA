import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  FlatList,
  KeyboardAvoidingView,
  LayoutAnimation,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { MaterialCommunityIcons as Icon } from '@expo/vector-icons';
import {
  COLORS,
  GROK_VOICES,
  LLM_MODELS,
  MONO_FONT,
  PERSONALITY_PRESETS,
  RADIUS,
  RESPONSE_STYLE_PRESETS,
  SPACING,
  TTS_VOICES,
  withAlpha,
} from '../../constants';
import { useAppStore } from '../../stores';
import { SecureStorage } from '../../services/secure-storage';
import { LogService, type LogEntry, type LogLevel } from '../../services/LogService';
import { LLMService } from '../../services/ai';
import { TTSService } from '../../services/ai/TTSService';
import {
  Button,
  Card,
  Divider,
  Hint,
  IconButton,
  OptionGroup,
  Pill,
  ScreenHeader,
  SectionLabel,
  ToggleRow,
  type Option,
} from '../../components';
import { formatSeconds } from '../../utils/format';
import type { APIKeys, LLMProvider, ResponseStyle, TTSProvider, TTSVoice } from '../../types';

type IconName = React.ComponentProps<typeof Icon>['name'];

const LLM_PROVIDER_LABELS: Record<LLMProvider, string> = {
  hermes: 'Hermes',
  opencode: 'OpenCode',
  nvidia: 'NVIDIA',
  minimax: 'MiniMax',
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  google: 'Google',
};
const LLM_PROVIDERS = Object.keys(LLM_PROVIDER_LABELS) as LLMProvider[];

const TTS_PROVIDER_LABELS: Record<TTSProvider, string> = {
  native: 'Voces del iPhone',
  server: 'Neural (servidor)',
  kokoro: 'Kokoro ⚡ baja latencia',
  openai: 'OpenAI',
  elevenlabs: 'ElevenLabs',
  minimax: 'MiniMax',
};
const TTS_PROVIDERS = Object.keys(TTS_PROVIDER_LABELS) as TTSProvider[];

const LISTENING_PRESETS = [
  { value: 'aggressive', label: 'Agresivo', silence: 850, final: 220, stop: 1100 },
  { value: 'fast', label: 'Rápido', silence: 1100, final: 300, stop: 1400 },
  { value: 'natural', label: 'Natural', silence: 1500, final: 450, stop: 1800 },
] as const;
const WAKE_REARM_PRESETS = [
  { value: 'instant', label: 'Instantáneo', resume: 70, cooldown: 500, trigger: 1000 },
  { value: 'safe', label: 'Seguro', resume: 120, cooldown: 750, trigger: 1500 },
  { value: 'anti-echo', label: 'Anti-eco', resume: 250, cooldown: 1200, trigger: 2200 },
] as const;
const LLM_TIMEOUT_OPTIONS: Option<number>[] = [22000, 45000, 90000, 120000].map((ms) => ({ value: ms, label: `${ms / 1000}s` }));
const TTS_RATE_OPTIONS: Option<number>[] = [
  { value: 0.96, label: 'Suave' },
  { value: 1.08, label: 'Ágil' },
  { value: 1.18, label: 'Rápida' },
];
const TTS_PITCH_OPTIONS: Option<number>[] = [
  { value: 0.92, label: 'Grave' },
  { value: 1.0, label: 'Neutro' },
  { value: 1.08, label: 'Brillante' },
];
const BLE_SCAN_OPTIONS: Option<number>[] = [2500, 3500, 6000].map((ms) => ({ value: ms, label: `${(ms / 1000).toFixed(1)}s` }));
const BLE_WATCH_OPTIONS: Option<number>[] = [5000, 7000, 12000].map((ms) => ({ value: ms, label: `${ms / 1000}s` }));
const DEFAULT_WAKE_WORD = 'KAIRO';

const API_KEY_FIELDS: Array<{ provider: keyof APIKeys; label: string; placeholder: string }> = [
  { provider: 'opencode', label: 'OpenCode Go', placeholder: 'oc_…' },
  { provider: 'openai', label: 'OpenAI', placeholder: 'sk-…' },
  { provider: 'anthropic', label: 'Anthropic', placeholder: 'sk-ant-…' },
  { provider: 'google', label: 'Google AI', placeholder: 'AIza…' },
  { provider: 'elevenlabs', label: 'ElevenLabs', placeholder: 'xi-…' },
  { provider: 'minimax', label: 'MiniMax', placeholder: 'eyJ…' },
  { provider: 'minimaxGroupId', label: 'MiniMax Group ID', placeholder: '17…' },
  { provider: 'nvidia', label: 'NVIDIA Build', placeholder: 'nvapi-…' },
];

const LOG_COLORS: Record<LogLevel, string> = {
  error: COLORS.error,
  warn: COLORS.warning,
  info: COLORS.primary,
  debug: COLORS.textMuted,
};

/* ─── Collapsible section ─────────────────────────── */
const Section: React.FC<{
  title: string;
  subtitle?: string;
  icon: IconName;
  expanded: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}> = ({ title, subtitle, icon, expanded, onToggle, children }) => (
  <View style={[styles.section, expanded && styles.sectionExpanded]}>
    <Pressable
      style={({ pressed }) => [styles.sectionHeader, pressed && { opacity: 0.75 }]}
      onPress={onToggle}
      accessibilityRole="button"
      accessibilityState={{ expanded }}
      accessibilityLabel={title}
    >
      <View style={[styles.sectionIcon, expanded && { backgroundColor: withAlpha(COLORS.primary, 0.16) }]}>
        <Icon name={icon} size={20} color={expanded ? COLORS.primary : COLORS.textSecondary} />
      </View>
      <View style={styles.flex}>
        <Text style={styles.sectionTitle}>{title}</Text>
        {subtitle ? <Text style={styles.sectionSubtitle} numberOfLines={1}>{subtitle}</Text> : null}
      </View>
      <Icon name={expanded ? 'chevron-up' : 'chevron-down'} size={22} color={expanded ? COLORS.primary : COLORS.textMuted} />
    </Pressable>
    {expanded ? <View style={styles.sectionBody}>{children}</View> : null}
  </View>
);

export const SettingsScreen: React.FC = () => {
  const settings = useAppStore((s) => s.settings);
  const updateSettings = useAppStore((s) => s.updateSettings);
  const resetSettings = useAppStore((s) => s.resetSettings);
  const latencyMetrics = useAppStore((s) => s.latencyMetrics);
  const pipelineState = useAppStore((s) => s.pipelineState);
  const isBluetoothConnected = useAppStore((s) => s.isBluetoothConnected);
  const bluetoothDeviceName = useAppStore((s) => s.bluetoothDeviceName);

  const [apiKeys, setApiKeys] = useState<Partial<Record<keyof APIKeys, string>>>({});
  const [showKeys, setShowKeys] = useState(false);
  const [logModalVisible, setLogModalVisible] = useState(false);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [logFilter, setLogFilter] = useState<LogLevel | 'all'>('all');
  const [logCount, setLogCount] = useState(() => LogService.getLogs().length);
  const [testingPipeline, setTestingPipeline] = useState(false);
  const [checkingHermes, setCheckingHermes] = useState(false);
  const [switchingHermesModel, setSwitchingHermesModel] = useState<string | null>(null);
  const [hermesSummary, setHermesSummary] = useState('Sin comprobar');
  const [pairingCode, setPairingCode] = useState('');
  const [proxyDeviceName, setProxyDeviceName] = useState('iPhone');
  const [proxyDeviceSummary, setProxyDeviceSummary] = useState('No vinculado');
  const [pairingProxyDevice, setPairingProxyDevice] = useState(false);
  const [checkingProxyAuth, setCheckingProxyAuth] = useState(false);
  const [revokingProxyDevice, setRevokingProxyDevice] = useState(false);
  const [playingVoice, setPlayingVoice] = useState<string | null>(null);
  const [nativeVoices, setNativeVoices] = useState<TTSVoice[]>([]);
  const [expanded, setExpanded] = useState<string | null>('assistant');
  const [customWakeMode, setCustomWakeMode] = useState(() => settings.wakeWord.trim().toUpperCase() !== DEFAULT_WAKE_WORD);
  const [wakeDraft, setWakeDraft] = useState(settings.wakeWord);
  const [promptDraft, setPromptDraft] = useState(settings.systemPrompt);

  // Follow external changes (personality presets, reset, async settings load).
  useEffect(() => setPromptDraft(settings.systemPrompt), [settings.systemPrompt]);
  useEffect(() => {
    setWakeDraft(settings.wakeWord);
    if (settings.wakeWord.trim().toUpperCase() !== DEFAULT_WAKE_WORD) setCustomWakeMode(true);
  }, [settings.wakeWord]);

  useEffect(() => {
    loadKeys();
    loadProxyDeviceAuth();
    TTSService.getAvailableNativeVoices('')
      .then((voices) => setNativeVoices(voices.filter((voice) => /^(es|en)/i.test(voice.language))))
      .catch(() => setNativeVoices([]));
    return LogService.subscribe(() => setLogCount(LogService.getLogs().length));
  }, []);

  useEffect(() => {
    if (!logModalVisible) return undefined;
    setLogs([...LogService.getLogs()]);
    return LogService.subscribe(() => setLogs([...LogService.getLogs()]));
  }, [logModalVisible]);

  const filteredLogs = useMemo(
    () => (logFilter === 'all' ? logs : logs.filter((entry) => entry.level === logFilter)),
    [logFilter, logs],
  );

  const toggleSection = useCallback((id: string) => {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setExpanded((current) => (current === id ? null : id));
  }, []);

  const modelsForProvider = useMemo(
    () => LLM_MODELS.filter((model) => model.provider === settings.llmProvider),
    [settings.llmProvider],
  );

  const voicesByProvider = useMemo(
    () => TTS_PROVIDERS.map((provider) => ({
      provider,
      voices: provider === 'native'
        ? [
            ...TTS_VOICES.filter((voice) => voice.provider === provider),
            ...nativeVoices.map((voice) => ({ ...voice, name: voice.name.replace(/\s+\([^)]+\)$/, '') })),
          ]
        : TTS_VOICES.filter((voice) => voice.provider === provider),
    })).filter((group) => group.voices.length > 0),
    [nativeVoices],
  );

  const currentModelName = modelsForProvider.find((m) => m.id === settings.llmModel)?.name ?? settings.llmModel;
  const currentVoiceName = voicesByProvider
    .flatMap((group) => group.voices)
    .find((voice) => voice.provider === settings.ttsProvider && voice.id === settings.ttsVoice)?.name ?? settings.ttsVoice;
  const activeListeningPreset = LISTENING_PRESETS.find((preset) => preset.silence === settings.silenceThresholdMs)?.value ?? null;
  const activeRearmPreset = WAKE_REARM_PRESETS.find((preset) => preset.resume === settings.wakeWordResumeDelayMs)?.value ?? null;

  /* ── Actions ── */
  const handleTestPipeline = useCallback(async () => {
    setTestingPipeline(true);
    LogService.info('Test', 'Starting pipeline test...');
    try {
      const t0 = Date.now();
      const response = await LLMService.chat(
        [{ id: 'test', role: 'user', content: 'Hola, responde con una frase corta.', timestamp: Date.now() }],
        'Responde en español de forma breve.',
        settings.llmProvider,
        settings.llmModel,
      );
      const elapsed = Date.now() - t0;
      LogService.info('Test', `LLM OK (${elapsed}ms): "${response}"`);
      Alert.alert('Modelo OK', `Respuesta en ${formatSeconds(elapsed)}:\n\n"${response}"`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      LogService.error('Test', `Pipeline test failed: ${msg}`);
      Alert.alert('El modelo no responde', msg);
    } finally {
      setTestingPipeline(false);
    }
  }, [settings.llmModel, settings.llmProvider]);

  const handleCheckHermes = useCallback(async () => {
    setCheckingHermes(true);
    try {
      const status = await LLMService.getHermesStatus();
      const runtime = status.runtime;
      const features = status.capabilities?.features;
      const enabledFeatures = features
        ? Object.entries(features).filter(([, enabled]) => enabled).map(([name]) => name)
        : [];
      const summary = [
        `${runtime?.provider ?? 'desconocido'}/${runtime?.model ?? 'sin modelo'}`,
        runtime?.switching_enabled ? 'cambio de modelo activo' : 'cambio de modelo desactivado',
        enabledFeatures.length ? `${enabledFeatures.length} capacidades` : 'capacidades N/D',
      ].join(' · ');
      setHermesSummary(summary);
      LogService.info('Hermes', `Status OK: ${summary}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setHermesSummary(`Error: ${msg}`);
      LogService.error('Hermes', `Status failed: ${msg}`);
    } finally {
      setCheckingHermes(false);
    }
  }, []);

  const handleSelectProvider = useCallback((provider: LLMProvider) => {
    const models = LLM_MODELS.filter((model) => model.provider === provider);
    updateSettings({ llmProvider: provider, ...(models[0] ? { llmModel: models[0].id } : {}) });
  }, [updateSettings]);

  const handleSelectLLMModel = useCallback(async (modelId: string) => {
    updateSettings({ llmModel: modelId });
    if (settings.llmProvider !== 'hermes' || modelId === 'hermes-agent') return;

    setSwitchingHermesModel(modelId);
    try {
      const runtime = await LLMService.switchHermesModel(modelId);
      const summary = `${runtime?.provider ?? 'hermes'}/${runtime?.model ?? modelId}`;
      setHermesSummary(summary);
      LogService.info('Hermes', `Model switched: ${summary}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      LogService.error('Hermes', `Model switch failed: ${msg}`);
      Alert.alert('Hermes', `No se pudo cambiar el modelo en el servidor: ${msg}`);
    } finally {
      setSwitchingHermesModel(null);
    }
  }, [settings.llmProvider, updateSettings]);

  const handleExportLogs = useCallback(async () => {
    try {
      await Share.share({ message: LogService.exportAsText(), title: 'KAIRO logs' });
    } catch {}
  }, []);

  const handleClearLogs = useCallback(() => {
    Alert.alert('Borrar logs', '¿Borrar todos los registros de diagnóstico?', [
      { text: 'Cancelar', style: 'cancel' },
      {
        text: 'Borrar',
        style: 'destructive',
        onPress: async () => {
          await LogService.clear();
          setLogs([]);
        },
      },
    ]);
  }, []);

  const handlePlayVoiceDemo = useCallback(async (voice: TTSVoice) => {
    if (playingVoice) return;
    if (pipelineState !== 'idle') {
      Alert.alert('KAIRO está ocupado', 'Espera a que termine el turno actual para probar voces.');
      return;
    }
    setPlayingVoice(voice.id);
    try {
      await TTSService.synthesize('Hola, soy KAIRO. Así sonará mi voz cuando te responda.', voice.provider, voice.id, {
        language: voice.language === 'multi' ? settings.ttsLanguage : voice.language,
        rate: settings.ttsRate,
        pitch: settings.ttsPitch,
        nativeVoiceId: voice.provider === 'native' && voice.id.startsWith('native-')
          ? settings.ttsNativeVoiceId
          : voice.id,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      Alert.alert('No se pudo reproducir', msg);
    } finally {
      setPlayingVoice(null);
    }
  }, [pipelineState, playingVoice, settings.ttsLanguage, settings.ttsNativeVoiceId, settings.ttsPitch, settings.ttsRate]);

  const loadKeys = async () => {
    const entries = await Promise.all(
      API_KEY_FIELDS.map(async ({ provider }) => [provider, (await SecureStorage.getAPIKey(provider)) || ''] as const),
    );
    setApiKeys(Object.fromEntries(entries));
  };

  const loadProxyDeviceAuth = async () => {
    const auth = await SecureStorage.getProxyDeviceAuth();
    if (!auth) {
      setProxyDeviceSummary('No vinculado');
      return;
    }
    const expires = auth.expiresAt
      ? new Date(auth.expiresAt * 1000).toLocaleDateString('es-ES')
      : 'sin caducidad';
    setProxyDeviceName(auth.deviceName || 'iPhone');
    setProxyDeviceSummary(`${auth.deviceName || 'iPhone'} · caduca ${expires}`);
  };

  const handlePairProxyDevice = useCallback(async () => {
    const code = pairingCode.trim();
    if (!code) {
      Alert.alert('Código requerido', 'Introduce el código de vinculación generado en el servidor.');
      return;
    }
    setPairingProxyDevice(true);
    try {
      const result = await LLMService.pairProxyDevice(code, proxyDeviceName);
      setPairingCode('');
      await loadProxyDeviceAuth();
      Alert.alert('iPhone vinculado', `${result.device_name} ya puede usar Hermes y el proxy.`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      Alert.alert('Vinculación fallida', msg);
    } finally {
      setPairingProxyDevice(false);
    }
  }, [pairingCode, proxyDeviceName]);

  const handleCheckProxyAuth = useCallback(async () => {
    setCheckingProxyAuth(true);
    try {
      const status = await LLMService.getProxyAuthStatus();
      const device = status.device;
      const summary = device
        ? `${device.name} · ${device.scopes.join(', ')}`
        : status.device_auth_enabled ? 'Autenticado' : 'Auth por dispositivo desactivada';
      setProxyDeviceSummary(summary);
      Alert.alert('Proxy seguro OK', summary);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      Alert.alert('Proxy seguro', msg);
    } finally {
      setCheckingProxyAuth(false);
    }
  }, []);

  const handleRevokeProxyDevice = useCallback(() => {
    Alert.alert('Desvincular iPhone', 'Este dispositivo dejará de poder usar Hermes hasta vincularlo otra vez.', [
      { text: 'Cancelar', style: 'cancel' },
      {
        text: 'Desvincular',
        style: 'destructive',
        onPress: async () => {
          setRevokingProxyDevice(true);
          try {
            await LLMService.revokeProxyDevice();
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            LogService.warn('ProxyAuth', `Remote revoke failed: ${msg}`);
            await SecureStorage.deleteProxyDeviceAuth();
          } finally {
            await loadProxyDeviceAuth();
            setRevokingProxyDevice(false);
          }
        },
      },
    ]);
  }, []);

  const saveKey = useCallback(async (provider: keyof APIKeys, label: string) => {
    const value = (apiKeys[provider] ?? '').trim();
    const ok = value
      ? await SecureStorage.saveAPIKey(provider, value)
      : await SecureStorage.deleteAPIKey(provider);
    if (!ok) {
      Alert.alert('Error', `No se pudo guardar la clave de ${label}.`);
      return;
    }
    Alert.alert(value ? 'Clave guardada' : 'Clave eliminada', `${label}: ${value ? 'guardada en el llavero del iPhone' : 'eliminada'}.`);
  }, [apiKeys]);

  const applyResponseStylePreset = useCallback((presetId: ResponseStyle) => {
    const preset = RESPONSE_STYLE_PRESETS.find((item) => item.id === presetId);
    if (!preset) return;
    updateSettings({
      responseStyle: preset.id,
      silenceThresholdMs: preset.silenceThresholdMs,
      finalSilenceThresholdMs: preset.finalSilenceThresholdMs,
      ttsRate: preset.ttsRate,
    });
  }, [updateSettings]);

  const commitWakeWord = () => {
    const value = wakeDraft.trim();
    if (value.length < 3) {
      Alert.alert('Palabra demasiado corta', 'Usa al menos 3 letras para evitar activaciones por error.');
      setWakeDraft(settings.wakeWord);
      return;
    }
    if (value !== settings.wakeWord) updateSettings({ wakeWord: value });
  };

  const handleWakeMode = (mode: 'kairo' | 'custom') => {
    if (mode === 'kairo') {
      setCustomWakeMode(false);
      updateSettings({ wakeWord: DEFAULT_WAKE_WORD, wakeWordLang: 'es-ES' });
    } else {
      setCustomWakeMode(true);
    }
  };

  const handleResetSettings = () => {
    Alert.alert(
      'Restablecer ajustes',
      'Se restaurarán los valores por defecto de voz, modelo y escucha. Tus conversaciones, perfil y claves no se tocan.',
      [
        { text: 'Cancelar', style: 'cancel' },
        { text: 'Restablecer', style: 'destructive', onPress: () => { setCustomWakeMode(false); resetSettings(); } },
      ],
    );
  };

  const promptDirty = promptDraft !== settings.systemPrompt;
  const personality = PERSONALITY_PRESETS.find((p) => p.id === settings.personalityId);

  const renderLogEntry = useCallback(({ item }: { item: LogEntry }) => (
    <View style={styles.logEntry}>
      <View style={styles.logMeta}>
        <Text style={[styles.logLevel, { color: LOG_COLORS[item.level] }]}>{item.level.toUpperCase()}</Text>
        <Text style={styles.logTag}>{item.tag}</Text>
        <Text style={styles.logTime}>
          {new Date(item.timestamp).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
        </Text>
      </View>
      <Text style={styles.logMessage} selectable>{item.message}</Text>
    </View>
  ), []);

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          <ScreenHeader title="Ajustes" subtitle="Personaliza cómo escucha, piensa y habla KAIRO." />

          {/* ── Status overview ── */}
          <Card style={styles.overview}>
            <View style={styles.overviewItem}>
              <Icon name="glasses" size={18} color={isBluetoothConnected ? COLORS.success : COLORS.textMuted} />
              <Text style={styles.overviewLabel}>Gafas</Text>
              <Text style={[styles.overviewValue, { color: isBluetoothConnected ? COLORS.success : COLORS.textSecondary }]} numberOfLines={1}>
                {isBluetoothConnected ? bluetoothDeviceName || 'Conectadas' : 'Sin conexión'}
              </Text>
            </View>
            <View style={styles.overviewDivider} />
            <View style={styles.overviewItem}>
              <Icon name="timer-outline" size={18} color={COLORS.primary} />
              <Text style={styles.overviewLabel}>Latencia</Text>
              <Text style={styles.overviewValue}>{formatSeconds(latencyMetrics?.totalMs)}</Text>
            </View>
            <View style={styles.overviewDivider} />
            <View style={styles.overviewItem}>
              <Icon name={settings.continuousConversation ? 'autorenew' : 'microphone-outline'} size={18} color={COLORS.speaking} />
              <Text style={styles.overviewLabel}>Modo</Text>
              <Text style={styles.overviewValue}>{settings.continuousConversation ? 'Continuo' : 'Por turnos'}</Text>
            </View>
          </Card>

          {/* ── Assistant ── */}
          <Section
            title="Asistente"
            subtitle={`${personality?.name ?? 'Personalizado'} · ${RESPONSE_STYLE_PRESETS.find((p) => p.id === settings.responseStyle)?.name ?? ''}`}
            icon="account-voice"
            expanded={expanded === 'assistant'}
            onToggle={() => toggleSection('assistant')}
          >
            <SectionLabel style={styles.firstLabel}>Personalidad</SectionLabel>
            <View style={styles.cardGrid}>
              {PERSONALITY_PRESETS.map((p) => {
                const active = settings.personalityId === p.id;
                return (
                  <Pressable
                    key={p.id}
                    style={({ pressed }) => [styles.choiceCard, active && styles.choiceCardActive, pressed && { opacity: 0.75 }]}
                    onPress={() => updateSettings({ personalityId: p.id, systemPrompt: p.systemPromptPrefix })}
                    accessibilityRole="radio"
                    accessibilityState={{ checked: active }}
                    accessibilityLabel={`${p.name}. ${p.description}`}
                  >
                    <Icon name={p.icon as IconName} size={22} color={active ? COLORS.primary : COLORS.textSecondary} />
                    <Text style={[styles.choiceTitle, active && { color: COLORS.primary }]}>{p.name}</Text>
                    <Text style={styles.choiceDesc}>{p.description}</Text>
                  </Pressable>
                );
              })}
            </View>

            <SectionLabel>Estilo de respuesta</SectionLabel>
            <OptionGroup
              options={RESPONSE_STYLE_PRESETS.map((preset) => ({ value: preset.id, label: preset.name }))}
              value={settings.responseStyle}
              onChange={applyResponseStylePreset}
            />
            <Hint style={styles.hintBelow}>
              {RESPONSE_STYLE_PRESETS.find((p) => p.id === settings.responseStyle)?.description}
            </Hint>

            <SectionLabel>Palabra de activación</SectionLabel>
            <OptionGroup
              options={[
                { value: 'kairo', label: DEFAULT_WAKE_WORD, icon: 'shield-half-full' },
                { value: 'custom', label: 'Personalizada', icon: 'pencil-outline' },
              ]}
              value={customWakeMode ? 'custom' : 'kairo'}
              onChange={handleWakeMode}
            />
            {customWakeMode ? (
              <View style={styles.inlineInputRow}>
                <TextInput
                  style={[styles.input, styles.flex]}
                  value={wakeDraft}
                  onChangeText={setWakeDraft}
                  onBlur={commitWakeWord}
                  onSubmitEditing={commitWakeWord}
                  placeholder="Ej. Oye Nova"
                  placeholderTextColor={COLORS.textMuted}
                  autoCapitalize="words"
                  autoCorrect={false}
                  returnKeyType="done"
                  maxLength={30}
                  accessibilityLabel="Palabra de activación personalizada"
                />
              </View>
            ) : null}
            <Hint style={styles.hintBelow}>
              También es el nombre visible del asistente. Las palabras cortas y poco comunes funcionan mejor.
            </Hint>

            <Divider style={styles.divider} />
            <ToggleRow
              title="Conversación continua"
              subtitle="Tras responder vuelve a escuchar sin repetir la palabra de activación"
              icon="autorenew"
              value={settings.continuousConversation}
              onValueChange={(value) => updateSettings({ continuousConversation: value })}
            />
            <ToggleRow
              title="Interrumpir con el botón"
              subtitle="El botón de las gafas corta la respuesta y te escucha"
              icon="gesture-tap-button"
              value={settings.interruptSpeechWithButton}
              onValueChange={(value) => updateSettings({ interruptSpeechWithButton: value })}
            />
            <ToggleRow
              title="Interrumpir con la voz"
              subtitle={`Decir "${settings.wakeWord}" mientras habla lo interrumpe`}
              icon="account-voice"
              value={settings.interruptSpeechWithWakeWord}
              onValueChange={(value) => updateSettings({ interruptSpeechWithWakeWord: value })}
            />
          </Section>

          {/* ── Model ── */}
          <Section
            title="Modelo de IA"
            subtitle={`${LLM_PROVIDER_LABELS[settings.llmProvider]} · ${currentModelName.replace(/^Hermes \/\s*/, '')}`}
            icon="brain"
            expanded={expanded === 'llm'}
            onToggle={() => toggleSection('llm')}
          >
            <SectionLabel style={styles.firstLabel}>Proveedor</SectionLabel>
            <OptionGroup
              options={LLM_PROVIDERS.map((provider) => ({ value: provider, label: LLM_PROVIDER_LABELS[provider] }))}
              value={settings.llmProvider}
              onChange={handleSelectProvider}
            />
            <SectionLabel>Modelo</SectionLabel>
            <OptionGroup
              options={modelsForProvider.map((model) => ({
                value: model.id,
                label: switchingHermesModel === model.id ? 'Cambiando…' : model.name.replace(/^Hermes \/\s*/, ''),
              }))}
              value={settings.llmModel}
              onChange={handleSelectLLMModel}
              disabled={switchingHermesModel !== null}
            />
            {settings.llmProvider === 'hermes' ? (
              <Hint style={styles.hintBelow}>
                Hermes mantiene su propia memoria y herramientas en el servidor. Cambiar de modelo reinicia Hermes (unos segundos).
              </Hint>
            ) : (
              <Hint style={styles.hintBelow}>
                Se envían las últimas respuestas de la conversación actual como contexto.
              </Hint>
            )}
            <Button
              label={testingPipeline ? 'Probando…' : 'Probar modelo'}
              icon="flask-outline"
              onPress={handleTestPipeline}
              loading={testingPipeline}
              style={styles.sectionButton}
            />
          </Section>

          {/* ── Voice ── */}
          <Section
            title="Voz"
            subtitle={settings.voiceMode === 'grok' ? `Grok Realtime · ${settings.grokVoiceId}` : currentVoiceName}
            icon="waveform"
            expanded={expanded === 'voice'}
            onToggle={() => toggleSection('voice')}
          >
            <SectionLabel style={styles.firstLabel}>Modo de voz</SectionLabel>
            <OptionGroup
              options={[
                { value: 'pipeline', label: 'Estándar', icon: 'transit-connection-variant' },
                { value: 'grok', label: 'Grok Realtime', icon: 'lightning-bolt' },
              ]}
              value={settings.voiceMode}
              onChange={(mode) => updateSettings({ voiceMode: mode })}
            />
            <Hint style={styles.hintBelow}>
              {settings.voiceMode === 'grok'
                ? 'Conversación voz a voz con Grok (de pago, ~0,05 $/min). Requiere build nativa en iOS. El wake word se desactiva en este modo.'
                : 'Escucha → modelo → voz. El más barato; con Kokoro la respuesta empieza a sonar en menos de un segundo.'}
            </Hint>

            {settings.voiceMode === 'grok' ? (
              <>
                <SectionLabel>Voz de Grok</SectionLabel>
                <OptionGroup
                  options={GROK_VOICES.map((voice) => ({ value: voice.id, label: voice.name }))}
                  value={settings.grokVoiceId}
                  onChange={(id) => updateSettings({ grokVoiceId: id })}
                />
              </>
            ) : (
              <>
                {voicesByProvider.map(({ provider, voices }) => (
                  <View key={provider}>
                    <SectionLabel>{TTS_PROVIDER_LABELS[provider]}</SectionLabel>
                    <View style={styles.voiceList}>
                      {voices.map((voice) => {
                        const active = settings.ttsProvider === provider && settings.ttsVoice === voice.id;
                        return (
                          <View key={`${provider}-${voice.id}`} style={[styles.voiceRow, active && styles.voiceRowActive]}>
                            <Pressable
                              style={styles.voiceSelect}
                              onPress={() => updateSettings({
                                ttsProvider: provider,
                                ttsVoice: voice.id,
                                ttsNativeVoiceId: provider === 'native' && !voice.id.startsWith('native-')
                                  ? voice.id
                                  : settings.ttsNativeVoiceId,
                                ttsLanguage: voice.language === 'multi' ? settings.ttsLanguage : voice.language,
                              })}
                              accessibilityRole="radio"
                              accessibilityState={{ checked: active }}
                              accessibilityLabel={voice.name}
                            >
                              <Icon
                                name={active ? 'radiobox-marked' : 'radiobox-blank'}
                                size={20}
                                color={active ? COLORS.primary : COLORS.textMuted}
                              />
                              <Text style={[styles.voiceName, active && { color: COLORS.primary }]} numberOfLines={1}>
                                {voice.name}
                              </Text>
                            </Pressable>
                            <IconButton
                              icon={playingVoice === voice.id ? 'volume-high' : 'play-circle-outline'}
                              label={`Escuchar ${voice.name}`}
                              onPress={() => handlePlayVoiceDemo(voice)}
                              disabled={playingVoice !== null && playingVoice !== voice.id}
                              color={playingVoice === voice.id ? COLORS.accent : COLORS.textSecondary}
                              size={22}
                            />
                          </View>
                        );
                      })}
                    </View>
                  </View>
                ))}
                {settings.ttsProvider === 'kokoro' ? (
                  <Card tone={COLORS.success} style={styles.noteCard}>
                    <Text style={styles.noteTitle}>⚡ Modo baja latencia activo</Text>
                    <Hint>
                      Kokoro en streaming solapa la respuesta del modelo, la síntesis y la reproducción. Combínalo con el estilo «Ultra-rápido».
                    </Hint>
                  </Card>
                ) : null}

                <SectionLabel>Velocidad</SectionLabel>
                <OptionGroup
                  options={TTS_RATE_OPTIONS}
                  value={TTS_RATE_OPTIONS.find((o) => Math.abs(o.value - settings.ttsRate) < 0.01)?.value ?? null}
                  onChange={(rate) => updateSettings({ ttsRate: rate })}
                />
                <SectionLabel>Tono</SectionLabel>
                <OptionGroup
                  options={TTS_PITCH_OPTIONS}
                  value={TTS_PITCH_OPTIONS.find((o) => Math.abs(o.value - settings.ttsPitch) < 0.01)?.value ?? null}
                  onChange={(pitch) => updateSettings({ ttsPitch: pitch })}
                />
              </>
            )}
          </Section>

          {/* ── Listening & latency ── */}
          <Section
            title="Escucha y rendimiento"
            subtitle={`Corte ${LISTENING_PRESETS.find((p) => p.value === activeListeningPreset)?.label ?? 'personalizado'} · timeout ${settings.llmRequestTimeoutMs / 1000}s`}
            icon="speedometer"
            expanded={expanded === 'performance'}
            onToggle={() => toggleSection('performance')}
          >
            <SectionLabel style={styles.firstLabel}>Fin de frase</SectionLabel>
            <OptionGroup
              options={LISTENING_PRESETS.map((preset) => ({ value: preset.value, label: preset.label }))}
              value={activeListeningPreset}
              onChange={(value) => {
                const preset = LISTENING_PRESETS.find((item) => item.value === value);
                if (preset) {
                  updateSettings({
                    silenceThresholdMs: preset.silence,
                    finalSilenceThresholdMs: preset.final,
                    sttStopTimeoutMs: preset.stop,
                  });
                }
              }}
            />
            <Hint style={styles.hintBelow}>Cuánto silencio espera antes de dar por terminada tu frase.</Hint>

            <SectionLabel>Rearme de la palabra de activación</SectionLabel>
            <OptionGroup
              options={WAKE_REARM_PRESETS.map((preset) => ({ value: preset.value, label: preset.label }))}
              value={activeRearmPreset}
              onChange={(value) => {
                const preset = WAKE_REARM_PRESETS.find((item) => item.value === value);
                if (preset) {
                  updateSettings({
                    wakeWordResumeDelayMs: preset.resume,
                    wakeWordCooldownMs: preset.cooldown,
                    wakeWordMinTriggerIntervalMs: preset.trigger,
                  });
                }
              }}
            />
            <Hint style={styles.hintBelow}>«Anti-eco» evita que KAIRO se active con su propia voz por los altavoces.</Hint>

            <SectionLabel>Tiempo máximo de respuesta</SectionLabel>
            <OptionGroup
              options={LLM_TIMEOUT_OPTIONS}
              value={settings.llmRequestTimeoutMs}
              onChange={(timeout) => updateSettings({ llmRequestTimeoutMs: timeout })}
            />

            <Divider style={styles.divider} />
            <ToggleRow
              title="Respuesta en streaming"
              subtitle="Muestra el texto mientras el modelo lo genera (Hermes/OpenCode)"
              icon="text-box-outline"
              value={settings.streamingEnabled}
              onValueChange={(value) => updateSettings({ streamingEnabled: value })}
            />
            <ToggleRow
              title="Hablar frase a frase"
              subtitle="Empieza a hablar antes de tener la respuesta completa"
              icon="format-quote-open"
              value={settings.ttsChunkedPlaybackEnabled}
              onValueChange={(value) => updateSettings({ ttsChunkedPlaybackEnabled: value })}
              disabled={!settings.streamingEnabled}
            />
          </Section>

          {/* ── Bluetooth ── */}
          <Section
            title="Gafas Bluetooth"
            subtitle={settings.autoConnectBluetooth ? 'Reconexión automática' : 'Conexión manual'}
            icon="bluetooth-connect"
            expanded={expanded === 'bluetooth'}
            onToggle={() => toggleSection('bluetooth')}
          >
            <ToggleRow
              title="Reconexión automática"
              subtitle="Vuelve a enlazar las gafas si se pierde la conexión"
              icon="bluetooth-connect"
              value={settings.autoConnectBluetooth}
              onValueChange={(value) => updateSettings({ autoConnectBluetooth: value })}
            />
            <ToggleRow
              title="Buscar al abrir la app"
              subtitle="Escaneo corto para encontrar las gafas al arrancar"
              icon="radar"
              value={settings.autoScanBluetoothOnLaunch}
              onValueChange={(value) => updateSettings({ autoScanBluetoothOnLaunch: value })}
            />
            <SectionLabel>Duración del escaneo</SectionLabel>
            <OptionGroup
              options={BLE_SCAN_OPTIONS}
              value={settings.bluetoothAutoScanDurationMs}
              onChange={(value) => updateSettings({ bluetoothAutoScanDurationMs: value })}
            />
            <SectionLabel>Comprobar conexión cada</SectionLabel>
            <OptionGroup
              options={BLE_WATCH_OPTIONS}
              value={settings.bluetoothAutoReconnectIntervalMs}
              onChange={(value) => updateSettings({ bluetoothAutoReconnectIntervalMs: value })}
            />
            <Hint style={styles.hintBelow}>El intervalo se aplica la próxima vez que abras la app.</Hint>
          </Section>

          {/* ── System prompt ── */}
          <Section
            title="Instrucciones del sistema"
            subtitle={promptDirty ? 'Cambios sin guardar' : 'Prompt base del asistente'}
            icon="script-text-outline"
            expanded={expanded === 'prompt'}
            onToggle={() => toggleSection('prompt')}
          >
            <TextInput
              style={[styles.input, styles.promptInput]}
              value={promptDraft}
              onChangeText={setPromptDraft}
              multiline
              placeholderTextColor={COLORS.textMuted}
              placeholder="Instrucciones del sistema…"
              accessibilityLabel="Instrucciones del sistema"
            />
            <View style={styles.buttonRow}>
              <Button
                label="Descartar"
                variant="secondary"
                compact
                onPress={() => setPromptDraft(settings.systemPrompt)}
                disabled={!promptDirty}
                style={styles.flex}
              />
              <Button
                label="Guardar"
                icon="content-save-outline"
                variant="primary"
                compact
                onPress={() => updateSettings({ systemPrompt: promptDraft.trim() || settings.systemPrompt })}
                disabled={!promptDirty}
                style={styles.flex}
              />
            </View>
            <Hint style={styles.hintBelow}>Elegir una personalidad reemplaza estas instrucciones.</Hint>
          </Section>

          {/* ── Proxy security ── */}
          <Section
            title="Seguridad del proxy"
            subtitle={proxyDeviceSummary}
            icon="cellphone-key"
            expanded={expanded === 'proxy'}
            onToggle={() => toggleSection('proxy')}
          >
            <Hint style={styles.firstHint}>
              Vincula este iPhone con un código temporal del servidor. El token se guarda en el llavero y se usa para Hermes, OpenCode y la voz del proxy.
            </Hint>
            <Card style={styles.statusCard} padded>
              <Text style={styles.statusLabel}>DISPOSITIVO</Text>
              <Text style={styles.statusValue}>{proxyDeviceSummary}</Text>
            </Card>

            <SectionLabel>Nombre del dispositivo</SectionLabel>
            <TextInput
              style={styles.input}
              value={proxyDeviceName}
              onChangeText={setProxyDeviceName}
              placeholder="iPhone"
              placeholderTextColor={COLORS.textMuted}
              autoCapitalize="words"
            />

            <SectionLabel>Código de vinculación</SectionLabel>
            <View style={styles.inlineInputRow}>
              <TextInput
                style={[styles.input, styles.flex, { fontFamily: MONO_FONT }]}
                value={pairingCode}
                onChangeText={setPairingCode}
                placeholder="SG-XXXXXX"
                placeholderTextColor={COLORS.textMuted}
                autoCapitalize="characters"
                autoCorrect={false}
              />
              <Button
                label="Vincular"
                icon="link-variant"
                variant="primary"
                onPress={handlePairProxyDevice}
                loading={pairingProxyDevice}
                disabled={!pairingCode.trim()}
              />
            </View>

            <View style={styles.buttonRow}>
              <Button
                label="Comprobar"
                icon="shield-check-outline"
                compact
                onPress={handleCheckProxyAuth}
                loading={checkingProxyAuth}
                style={styles.flex}
              />
              <Button
                label="Desvincular"
                icon="cellphone-remove"
                variant="danger"
                compact
                onPress={handleRevokeProxyDevice}
                loading={revokingProxyDevice}
                style={styles.flex}
              />
            </View>
          </Section>

          {/* ── API keys ── */}
          <Section
            title="Claves de API"
            subtitle="Solo para proveedores directos"
            icon="key-variant"
            expanded={expanded === 'api'}
            onToggle={() => toggleSection('api')}
          >
            <View style={styles.keysHeader}>
              <Hint style={styles.flex}>
                Normalmente no hacen falta: el proxy guarda las claves en el servidor. Se almacenan cifradas en el llavero del iPhone. Deja el campo vacío y guarda para borrar una clave.
              </Hint>
              <IconButton
                icon={showKeys ? 'eye-off-outline' : 'eye-outline'}
                label={showKeys ? 'Ocultar claves' : 'Mostrar claves'}
                onPress={() => setShowKeys(!showKeys)}
                color={COLORS.primary}
                filled
              />
            </View>
            {API_KEY_FIELDS.map(({ provider, label, placeholder }) => (
              <View key={provider} style={styles.keyRow}>
                <Text style={styles.keyLabel}>{label}</Text>
                <View style={styles.inlineInputRow}>
                  <TextInput
                    style={[styles.input, styles.flex, { fontFamily: MONO_FONT, fontSize: 13 }]}
                    value={apiKeys[provider] ?? ''}
                    onChangeText={(text) => setApiKeys((keys) => ({ ...keys, [provider]: text }))}
                    placeholder={placeholder}
                    placeholderTextColor={COLORS.textMuted}
                    secureTextEntry={!showKeys}
                    autoCapitalize="none"
                    autoCorrect={false}
                    accessibilityLabel={`Clave de ${label}`}
                  />
                  <IconButton
                    icon="content-save-outline"
                    label={`Guardar clave de ${label}`}
                    onPress={() => saveKey(provider, label)}
                    color={COLORS.primary}
                    filled
                    style={styles.keySave}
                  />
                </View>
              </View>
            ))}
          </Section>

          {/* ── Diagnostics ── */}
          <Section
            title="Diagnóstico"
            subtitle={`${logCount} registros`}
            icon="stethoscope"
            expanded={expanded === 'diagnostics'}
            onToggle={() => toggleSection('diagnostics')}
          >
            <View style={styles.buttonRow}>
              <Button
                label="Estado de Hermes"
                icon="server-network"
                compact
                onPress={handleCheckHermes}
                loading={checkingHermes}
                style={styles.flex}
              />
              <Button
                label={`Ver logs (${logCount})`}
                icon="text-box-search-outline"
                compact
                onPress={() => setLogModalVisible(true)}
                style={styles.flex}
              />
            </View>
            <Card style={styles.statusCard} padded>
              <Text style={styles.statusLabel}>HERMES</Text>
              <Text style={styles.statusValue}>{hermesSummary}</Text>
            </Card>
            {Platform.OS === 'web' ? (
              <ToggleRow
                title="Guardar audio de STT"
                subtitle="Graba lo que oye el reconocimiento (solo web, diagnóstico)"
                icon="record-rec"
                value={settings.speechDebugAudioEnabled}
                onValueChange={(value) => updateSettings({ speechDebugAudioEnabled: value })}
              />
            ) : null}
            <Hint style={styles.hintBelow}>
              La pestaña Debug tiene pruebas de micrófono, voz, Bluetooth y botones de las gafas.
            </Hint>
          </Section>

          <Button
            label="Restablecer ajustes por defecto"
            icon="restore"
            variant="ghost"
            onPress={handleResetSettings}
            style={styles.resetButton}
          />
          <Text style={styles.footer}>KAIRO · SmartGlasses AI</Text>
        </ScrollView>
      </KeyboardAvoidingView>

      {/* Log Viewer Modal */}
      <Modal
        visible={logModalVisible}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setLogModalVisible(false)}
      >
        <SafeAreaView style={styles.modalContainer}>
          <View style={styles.modalHeader}>
            <Text style={styles.modalTitle}>Logs</Text>
            <View style={styles.modalActions}>
              <IconButton icon="share-variant" label="Exportar logs" onPress={handleExportLogs} color={COLORS.primary} />
              <IconButton icon="delete-outline" label="Borrar logs" onPress={handleClearLogs} color={COLORS.error} />
              <IconButton icon="close" label="Cerrar" onPress={() => setLogModalVisible(false)} color={COLORS.text} />
            </View>
          </View>
          <View style={styles.logFilters}>
            {(['all', 'error', 'warn', 'info', 'debug'] as const).map((level) => (
              <Pill
                key={level}
                label={level === 'all' ? `Todos · ${logs.length}` : level.toUpperCase()}
                color={logFilter === level ? (level === 'all' ? COLORS.primary : LOG_COLORS[level]) : COLORS.textMuted}
                onPress={() => setLogFilter(level)}
              />
            ))}
          </View>
          <FlatList
            data={filteredLogs}
            keyExtractor={(item) => item.id}
            renderItem={renderLogEntry}
            initialNumToRender={30}
            maxToRenderPerBatch={30}
            windowSize={7}
            contentContainerStyle={{ padding: SPACING.md }}
            ListEmptyComponent={<Hint style={{ textAlign: 'center', marginTop: SPACING.lg }}>No hay registros.</Hint>}
          />
        </SafeAreaView>
      </Modal>
    </SafeAreaView>
  );
};

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: COLORS.background },
  flex: { flex: 1 },
  content: { paddingHorizontal: SPACING.md, paddingBottom: SPACING.xxl },
  overview: {
    flexDirection: 'row',
    alignItems: 'stretch',
    marginBottom: SPACING.md,
    paddingVertical: 14,
    paddingHorizontal: 8,
  },
  overviewItem: { flex: 1, alignItems: 'center', gap: 4, paddingHorizontal: 4 },
  overviewDivider: { width: StyleSheet.hairlineWidth, backgroundColor: COLORS.border },
  overviewLabel: { fontSize: 10, fontWeight: '800', color: COLORS.textMuted, letterSpacing: 0.6, textTransform: 'uppercase' },
  overviewValue: { fontSize: 13, fontWeight: '700', color: COLORS.text },
  section: {
    backgroundColor: COLORS.card,
    borderRadius: RADIUS.lg,
    borderWidth: 1,
    borderColor: COLORS.border,
    marginBottom: 10,
    overflow: 'hidden',
  },
  sectionExpanded: { borderColor: withAlpha(COLORS.primary, 0.35) },
  sectionHeader: {
    minHeight: 64,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  sectionIcon: {
    width: 38,
    height: 38,
    borderRadius: 11,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: COLORS.surfaceLight,
  },
  sectionTitle: { fontSize: 16, fontWeight: '700', color: COLORS.text },
  sectionSubtitle: { fontSize: 12, color: COLORS.textSecondary, marginTop: 2 },
  sectionBody: {
    paddingHorizontal: 14,
    paddingBottom: 16,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: COLORS.border,
  },
  firstLabel: { marginTop: 14 },
  firstHint: { marginTop: 14 },
  hintBelow: { marginTop: 8 },
  divider: { marginTop: SPACING.md },
  sectionButton: { marginTop: SPACING.md },
  cardGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  choiceCard: {
    width: '48.5%',
    flexGrow: 1,
    backgroundColor: COLORS.surface,
    borderRadius: RADIUS.md,
    padding: 12,
    borderWidth: 1,
    borderColor: COLORS.border,
    gap: 4,
  },
  choiceCardActive: { borderColor: COLORS.primary, backgroundColor: withAlpha(COLORS.primary, 0.1) },
  choiceTitle: { fontSize: 14, fontWeight: '800', color: COLORS.text, marginTop: 4 },
  choiceDesc: { fontSize: 12, color: COLORS.textSecondary, lineHeight: 16 },
  inlineInputRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 10 },
  input: {
    backgroundColor: COLORS.surface,
    borderRadius: RADIUS.md,
    borderWidth: 1,
    borderColor: COLORS.border,
    paddingHorizontal: 12,
    paddingVertical: 11,
    color: COLORS.text,
    fontSize: 15,
  },
  promptInput: { minHeight: 140, textAlignVertical: 'top', marginTop: 14, lineHeight: 20 },
  buttonRow: { flexDirection: 'row', gap: 8, marginTop: 12 },
  voiceList: {
    backgroundColor: COLORS.surface,
    borderRadius: RADIUS.md,
    borderWidth: 1,
    borderColor: COLORS.border,
    overflow: 'hidden',
  },
  voiceRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingRight: 6,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: COLORS.border,
  },
  voiceRowActive: { backgroundColor: withAlpha(COLORS.primary, 0.08) },
  voiceSelect: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 12, paddingVertical: 12 },
  voiceName: { flex: 1, fontSize: 14, color: COLORS.text, fontWeight: '600' },
  noteCard: { marginTop: 12, gap: 4 },
  noteTitle: { fontSize: 13, fontWeight: '800', color: COLORS.success },
  statusCard: { marginTop: 12, backgroundColor: COLORS.surface },
  statusLabel: { fontSize: 10, fontWeight: '800', color: COLORS.textMuted, letterSpacing: 0.8, marginBottom: 4 },
  statusValue: { fontSize: 13, color: COLORS.text, lineHeight: 18 },
  keysHeader: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, marginTop: 14, marginBottom: 4 },
  keyRow: { marginTop: 10 },
  keyLabel: { fontSize: 13, fontWeight: '700', color: COLORS.textSecondary },
  keySave: { width: 46, height: 46 },
  resetButton: { marginTop: SPACING.md },
  footer: { textAlign: 'center', color: COLORS.textMuted, fontSize: 12, marginTop: 4 },
  // Log viewer modal
  modalContainer: { flex: 1, backgroundColor: COLORS.background },
  modalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: SPACING.md,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: COLORS.border,
  },
  modalTitle: { fontSize: 20, fontWeight: '800', color: COLORS.text },
  modalActions: { flexDirection: 'row', gap: 4, alignItems: 'center' },
  logFilters: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, paddingHorizontal: SPACING.md, paddingTop: 10 },
  logEntry: {
    marginBottom: 8,
    paddingBottom: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: COLORS.border,
  },
  logMeta: { flexDirection: 'row', gap: 8, alignItems: 'center', marginBottom: 3 },
  logLevel: { fontSize: 10, fontWeight: '800', fontFamily: MONO_FONT },
  logTag: { fontSize: 10, color: COLORS.textSecondary, fontFamily: MONO_FONT },
  logTime: { fontSize: 10, color: COLORS.textMuted, marginLeft: 'auto', fontFamily: MONO_FONT },
  logMessage: { fontSize: 12, color: COLORS.text, lineHeight: 17, fontFamily: MONO_FONT },
});
