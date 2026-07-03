import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  ScrollView,
  StyleSheet,
  Alert,
  FlatList,
  Share,
  Modal,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { MaterialCommunityIcons as Icon } from '@expo/vector-icons';
import {
  COLORS,
  GROK_VOICES,
  LLM_MODELS,
  PERSONALITY_PRESETS,
  RESPONSE_STYLE_PRESETS,
  TTS_VOICES,
  WAKE_WORD_PRESETS,
} from '../../constants';
import { useAppStore } from '../../stores';
import { SecureStorage } from '../../services/secure-storage';
import { LogService, type LogEntry, type LogLevel } from '../../services/LogService';
import { LLMService } from '../../services/ai';
import { TTSService } from '../../services/ai/TTSService';
import type { APIKeys, LLMProvider, TTSProvider, TTSVoice } from '../../types';

const LLM_PROVIDERS: LLMProvider[] = ['hermes', 'opencode', 'nvidia', 'minimax', 'openai', 'anthropic', 'google'];
const TTS_PROVIDERS: TTSProvider[] = ['native', 'server', 'kokoro', 'openai', 'elevenlabs', 'minimax'];
const BOOLEAN_OPTIONS = [true, false];
const LISTENING_PRESETS = [
  { label: 'Agresivo', silence: 850, final: 220, stop: 1100 },
  { label: 'Rapido', silence: 1100, final: 300, stop: 1400 },
  { label: 'Natural', silence: 1500, final: 450, stop: 1800 },
];
const WAKE_REARM_PRESETS = [
  { label: 'Instantaneo', resume: 70, cooldown: 500, trigger: 1000 },
  { label: 'Seguro', resume: 120, cooldown: 750, trigger: 1500 },
  { label: 'Anti-eco', resume: 250, cooldown: 1200, trigger: 2200 },
];
const LLM_TIMEOUTS = [22000, 45000, 90000, 120000];
const TTS_RATES = [0.96, 1.08, 1.18];
const TTS_PITCHES = [0.92, 1.0, 1.08];
const BLUETOOTH_SCAN_DURATIONS = [2500, 3500, 6000];
const BLUETOOTH_RECONNECT_INTERVALS = [5000, 7000, 12000];
const LOG_COLORS: Record<LogLevel, string> = {
  error: '#FF4444',
  warn: '#FFAA00',
  info: '#4488FF',
  debug: '#888888',
};

export const SettingsScreen: React.FC = () => {
  const { settings, updateSettings, latencyMetrics, isBluetoothConnected, bluetoothDeviceName } = useAppStore();

  const [openaiKey, setOpenaiKey] = useState('');
  const [anthropicKey, setAnthropicKey] = useState('');
  const [googleKey, setGoogleKey] = useState('');
  const [elevenlabsKey, setElevenlabsKey] = useState('');
  const [minimaxKey, setMinimaxKey] = useState('');
  const [opencodeKey, setOpencodeKey] = useState('');
  const [nvidiaKey, setNvidiaKey] = useState('');
  const [minimaxGroupId, setMinimaxGroupId] = useState('');
  const [showKeys, setShowKeys] = useState(false);
  const [logModalVisible, setLogModalVisible] = useState(false);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [logCount, setLogCount] = useState(() => LogService.getLogs().length);
  const [testingPipeline, setTestingPipeline] = useState(false);
  const [checkingHermes, setCheckingHermes] = useState(false);
  const [switchingHermesModel, setSwitchingHermesModel] = useState<string | null>(null);
  const [hermesSummary, setHermesSummary] = useState('Sin comprobar');
  const [pairingCode, setPairingCode] = useState('');
  const [proxyDeviceName, setProxyDeviceName] = useState('Amalio iPhone');
  const [proxyDeviceSummary, setProxyDeviceSummary] = useState('No vinculado');
  const [pairingProxyDevice, setPairingProxyDevice] = useState(false);
  const [checkingProxyAuth, setCheckingProxyAuth] = useState(false);
  const [revokingProxyDevice, setRevokingProxyDevice] = useState(false);
  const [playingVoice, setPlayingVoice] = useState<string | null>(null);
  const [nativeVoices, setNativeVoices] = useState<TTSVoice[]>([]);
  const [expandedSections, setExpandedSections] = useState<Record<string, boolean>>({});

  useEffect(() => {
    loadKeys();
    loadProxyDeviceAuth();
  }, []);

  useEffect(() => {
    TTSService.getAvailableNativeVoices('')
      .then((voices) => setNativeVoices(voices))
      .catch(() => setNativeVoices([]));
  }, []);

  useEffect(() => {
    if (!logModalVisible) return undefined;
    setLogs(LogService.getLogs());
    const unsub = LogService.subscribe(() => {
      const nextLogs = LogService.getLogs();
      setLogs([...nextLogs]);
      setLogCount(nextLogs.length);
    });
    return unsub;
  }, [logModalVisible]);

  const modelsForProvider = useMemo(
    () => LLM_MODELS.filter((model) => model.provider === settings.llmProvider),
    [settings.llmProvider],
  );

  const nativeVoiceOptions = useMemo(
    () => nativeVoices.map((voice) => ({
      ...voice,
      name: voice.name.replace(/\s+\([^)]+\)$/, ''),
    })),
    [nativeVoices],
  );

  const voicesByProvider = useMemo(
    () => TTS_PROVIDERS.map((provider) => ({
      provider,
      voices: provider === 'native'
        ? [...TTS_VOICES.filter((voice) => voice.provider === provider), ...nativeVoiceOptions]
        : TTS_VOICES.filter((voice) => voice.provider === provider),
    })).filter((group) => group.voices.length > 0),
    [nativeVoiceOptions],
  );

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
      Alert.alert('Pipeline OK', `Respuesta en ${elapsed}ms:\n\n"${response}"`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      LogService.error('Test', `Pipeline test failed: ${msg}`);
      Alert.alert('Pipeline Error', msg);
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
        runtime?.switching_enabled ? 'switch activo' : 'switch off',
        enabledFeatures.length ? `${enabledFeatures.length} capacidades` : 'capacidades N/A',
      ].join(' · ');
      setHermesSummary(summary);
      LogService.info('Hermes', `Status OK: ${summary}`);
      Alert.alert('Hermes OK', summary);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setHermesSummary('Error');
      LogService.error('Hermes', `Status failed: ${msg}`);
      Alert.alert('Hermes Error', msg);
    } finally {
      setCheckingHermes(false);
    }
  }, []);

  const handleSelectLLMModel = useCallback(async (modelId: string) => {
    updateSettings({ llmModel: modelId });
    if (settings.llmProvider !== 'hermes' || modelId === 'hermes-agent') {
      return;
    }

    setSwitchingHermesModel(modelId);
    try {
      const runtime = await LLMService.switchHermesModel(modelId);
      const summary = `${runtime?.provider ?? 'hermes'}/${runtime?.model ?? modelId}`;
      setHermesSummary(summary);
      LogService.info('Hermes', `Model switched: ${summary}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      LogService.error('Hermes', `Model switch failed: ${msg}`);
      Alert.alert('Hermes', `No se pudo cambiar el modelo: ${msg}`);
    } finally {
      setSwitchingHermesModel(null);
    }
  }, [settings.llmProvider, updateSettings]);

  const handleExportLogs = useCallback(async () => {
    const text = LogService.exportAsText();
    try {
      await Share.share({ message: text, title: 'SmartGlasses Logs' });
    } catch {}
  }, []);

  const handleClearLogs = useCallback(() => {
    Alert.alert('Borrar logs', '¿Borrar todos los logs?', [
      { text: 'Cancelar', style: 'cancel' },
      {
        text: 'Borrar',
        style: 'destructive',
        onPress: async () => {
          await LogService.clear();
          setLogs([]);
          setLogCount(0);
        },
      },
    ]);
  }, []);

  const openLogModal = useCallback(() => {
    const nextLogs = LogService.getLogs();
    setLogs([...nextLogs]);
    setLogCount(nextLogs.length);
    setLogModalVisible(true);
  }, []);

  const toggleSection = useCallback((sectionId: string) => {
    setExpandedSections((state) => ({ ...state, [sectionId]: !state[sectionId] }));
  }, []);

  const renderSection = (
    sectionId: string,
    title: string,
    icon: string,
    children: () => React.ReactNode,
    subtitle?: string,
  ) => {
    const expanded = Boolean(expandedSections[sectionId]);
    return (
      <View style={styles.section}>
        <TouchableOpacity
          style={styles.collapsibleHeader}
          onPress={() => toggleSection(sectionId)}
          activeOpacity={0.75}
        >
          <View style={styles.collapsibleTitleRow}>
            <Icon name={icon as any} size={20} color={expanded ? COLORS.primary : COLORS.textSecondary} />
            <View style={{ flex: 1 }}>
              <Text style={styles.sectionTitle}>{title}</Text>
              {subtitle ? <Text style={styles.sectionSubtitle} numberOfLines={1}>{subtitle}</Text> : null}
            </View>
          </View>
          <Icon
            name={expanded ? 'chevron-up' : 'chevron-down'}
            size={24}
            color={expanded ? COLORS.primary : COLORS.textSecondary}
          />
        </TouchableOpacity>
        {expanded ? <View style={styles.sectionBody}>{children()}</View> : null}
      </View>
    );
  };

  const handlePlayVoiceDemo = useCallback(async (voice: TTSVoice) => {
    if (playingVoice) return;
    setPlayingVoice(voice.id);
    try {
      await TTSService.synthesize('Hola, soy tu asistente de voz. Estoy lista para ayudarte rápido y con naturalidad.', voice.provider as TTSProvider, voice.id, {
        language: voice.language === 'multi' ? settings.ttsLanguage : voice.language,
        rate: settings.ttsRate,
        pitch: settings.ttsPitch,
        nativeVoiceId: voice.provider === 'native' && voice.id.startsWith('native-')
          ? settings.ttsNativeVoiceId
          : voice.id,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      Alert.alert('Error', `No se pudo reproducir la demo: ${msg}`);
    } finally {
      setPlayingVoice(null);
    }
  }, [playingVoice, settings.ttsLanguage, settings.ttsNativeVoiceId, settings.ttsPitch, settings.ttsRate]);

  const loadKeys = async () => {
    const keys = await Promise.all([
      SecureStorage.getAPIKey('openai'),
      SecureStorage.getAPIKey('anthropic'),
      SecureStorage.getAPIKey('google'),
      SecureStorage.getAPIKey('elevenlabs'),
      SecureStorage.getAPIKey('minimax'),
      SecureStorage.getAPIKey('opencode'),
      SecureStorage.getAPIKey('nvidia'),
      SecureStorage.getAPIKey('minimaxGroupId'),
    ]);
    setOpenaiKey(keys[0] || '');
    setAnthropicKey(keys[1] || '');
    setGoogleKey(keys[2] || '');
    setElevenlabsKey(keys[3] || '');
    setMinimaxKey(keys[4] || '');
    setOpencodeKey(keys[5] || '');
    setNvidiaKey(keys[6] || '');
    setMinimaxGroupId(keys[7] || '');
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
    setProxyDeviceName(auth.deviceName || 'Amalio iPhone');
    setProxyDeviceSummary(`${auth.deviceName || 'iPhone'} · ${auth.deviceId.slice(0, 12)} · exp ${expires}`);
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
        ? `${device.name} · ${device.id.slice(0, 12)} · ${device.scopes.join(', ')}`
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

  const saveKey = useCallback(async (provider: keyof APIKeys, value: string) => {
    try {
      const saved = await SecureStorage.saveAPIKey(provider, value.trim());
      if (!saved) {
        Alert.alert('Error', 'No se pudo guardar la API key');
        return;
      }
      Alert.alert('Guardado', `API Key de ${provider} guardada correctamente`);
    } catch (error) {
      Alert.alert('Error', 'No se pudo guardar la API key');
    }
  }, []);

  const applyResponseStylePreset = useCallback((presetId: 'instant' | 'balanced' | 'natural') => {
    const preset = RESPONSE_STYLE_PRESETS.find((item) => item.id === presetId);
    if (!preset) return;
    updateSettings({
      responseStyle: preset.id,
      silenceThresholdMs: preset.silenceThresholdMs,
      finalSilenceThresholdMs: preset.finalSilenceThresholdMs,
      ttsRate: preset.ttsRate,
    });
  }, [updateSettings]);

  const renderKeyInput = (
    label: string,
    provider: keyof APIKeys,
    value: string,
    setter: (v: string) => void,
    placeholder: string,
  ) => (
    <View style={styles.keyRow}>
      <Text style={styles.keyLabel}>{label}</Text>
      <View style={styles.keyInputRow}>
        <TextInput
          style={styles.keyInput}
          value={value}
          onChangeText={setter}
          placeholder={placeholder}
          placeholderTextColor={COLORS.textSecondary}
          secureTextEntry={!showKeys}
          autoCapitalize="none"
          autoCorrect={false}
        />
        <TouchableOpacity
          style={styles.saveButton}
          onPress={() => saveKey(provider, value)}
        >
          <Icon name="content-save" size={20} color={COLORS.primary} />
        </TouchableOpacity>
      </View>
    </View>
  );

  const renderLogEntry = useCallback(({ item }: { item: LogEntry }) => (
    <View style={styles.logEntry}>
      <View style={styles.logMeta}>
        <Text style={[styles.logLevel, { color: LOG_COLORS[item.level] }]}>
          {item.level.toUpperCase()}
        </Text>
        <Text style={styles.logTag}>[{item.tag}]</Text>
        <Text style={styles.logTime}>
          {new Date(item.timestamp).toLocaleTimeString('es-ES', {
            hour: '2-digit', minute: '2-digit', second: '2-digit',
          })}
        </Text>
      </View>
      <Text style={styles.logMessage}>{item.message}</Text>
    </View>
  ), []);

  const keyLogEntry = useCallback((item: LogEntry) => item.id, []);

  return (
    <SafeAreaView style={styles.container}>
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.consoleHeader}>
          <View style={styles.headerTitleRow}>
            <Icon name="shield-half-full" size={24} color={COLORS.primary} />
            <View style={{ flex: 1 }}>
              <Text style={styles.title}>KAIRO Console</Text>
              <Text style={styles.headerSubtitle}>
                {settings.llmProvider}/{settings.llmModel} · {settings.ttsProvider}/{settings.ttsVoice}
              </Text>
            </View>
          </View>
          <View style={styles.headerMetrics}>
            <View style={styles.metricPill}>
              <Text style={styles.metricLabel}>BLE</Text>
              <Text style={[styles.metricValue, { color: isBluetoothConnected ? COLORS.success : COLORS.error }]}>
                {isBluetoothConnected ? bluetoothDeviceName || 'OK' : 'OFF'}
              </Text>
            </View>
            <View style={styles.metricPill}>
              <Text style={styles.metricLabel}>LAT</Text>
              <Text style={styles.metricValue}>
                {latencyMetrics?.totalMs ? `${(latencyMetrics.totalMs / 1000).toFixed(1)}s` : 'N/A'}
              </Text>
            </View>
            <View style={styles.metricPill}>
              <Text style={styles.metricLabel}>MODE</Text>
              <Text style={[styles.metricValue, { color: settings.continuousConversation ? COLORS.success : COLORS.textSecondary }]}>
                {settings.continuousConversation ? 'LIVE' : 'WAKE'}
              </Text>
            </View>
          </View>
        </View>

        {renderSection('api', 'API Keys', 'key-variant', () => (
          <>
            <View style={styles.inlineSectionAction}>
              <Text style={styles.hintText}>Guarda credenciales locales para proveedores directos.</Text>
              <TouchableOpacity style={styles.iconOnlyButton} onPress={() => setShowKeys(!showKeys)}>
                <Icon name={showKeys ? 'eye-off' : 'eye'} size={20} color={COLORS.primary} />
              </TouchableOpacity>
            </View>
            {renderKeyInput('OpenAI', 'openai', openaiKey, setOpenaiKey, 'sk-...')}
            {renderKeyInput('Anthropic', 'anthropic', anthropicKey, setAnthropicKey, 'sk-ant-...')}
            {renderKeyInput('Google', 'google', googleKey, setGoogleKey, 'AIza...')}
            {renderKeyInput('ElevenLabs', 'elevenlabs', elevenlabsKey, setElevenlabsKey, 'xi-...')}
            {renderKeyInput('MiniMax', 'minimax', minimaxKey, setMinimaxKey, 'eyJ...')}
            {renderKeyInput('OpenCode Go', 'opencode', opencodeKey, setOpencodeKey, 'oc_...')}
            {renderKeyInput('NVIDIA Build', 'nvidia', nvidiaKey, setNvidiaKey, 'nvapi-...')}
            {renderKeyInput('MiniMax Group ID', 'minimaxGroupId', minimaxGroupId, setMinimaxGroupId, '17...')}
          </>
        ), showKeys ? 'Claves visibles' : 'Claves ocultas')}

        {renderSection('proxySecurity', 'Seguridad del Proxy', 'cellphone-key', () => (
          <>
            <Text style={styles.hintText}>
              Vincula este iPhone con un código temporal del servidor. El token queda en el llavero del dispositivo y se usa para Hermes, OpenCode, tareas y voz del proxy.
            </Text>

            <View style={styles.statusPanel}>
              <Text style={styles.statusPanelLabel}>DISPOSITIVO</Text>
              <Text style={styles.statusPanelValue}>{proxyDeviceSummary}</Text>
            </View>

            <Text style={styles.subsectionTitle}>Nombre del dispositivo</Text>
            <TextInput
              style={styles.wakeWordInput}
              value={proxyDeviceName}
              onChangeText={setProxyDeviceName}
              placeholder="Amalio iPhone"
              placeholderTextColor={COLORS.textSecondary}
              autoCapitalize="words"
            />

            <Text style={styles.subsectionTitle}>Código de vinculación</Text>
            <View style={styles.keyInputRow}>
              <TextInput
                style={styles.keyInput}
                value={pairingCode}
                onChangeText={setPairingCode}
                placeholder="SG-XXXXXX"
                placeholderTextColor={COLORS.textSecondary}
                autoCapitalize="characters"
                autoCorrect={false}
              />
              <TouchableOpacity
                style={styles.saveButton}
                onPress={handlePairProxyDevice}
                disabled={pairingProxyDevice}
              >
                <Icon name={pairingProxyDevice ? 'loading' : 'link-variant'} size={20} color={COLORS.primary} />
              </TouchableOpacity>
            </View>

            <TouchableOpacity
              style={[styles.diagButton, { marginTop: 12 }]}
              onPress={handleCheckProxyAuth}
              disabled={checkingProxyAuth}
            >
              <Icon name="shield-check-outline" size={20} color={COLORS.primary} />
              <Text style={styles.diagButtonText}>
                {checkingProxyAuth ? 'Comprobando...' : 'Comprobar token del iPhone'}
              </Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={styles.diagButton}
              onPress={handleRevokeProxyDevice}
              disabled={revokingProxyDevice}
            >
              <Icon name="cellphone-remove" size={20} color={COLORS.error} />
              <Text style={[styles.diagButtonText, { color: COLORS.error }]}>
                {revokingProxyDevice ? 'Desvinculando...' : 'Desvincular este iPhone'}
              </Text>
            </TouchableOpacity>
          </>
        ), proxyDeviceSummary)}

        {renderSection('llm', 'Proveedor LLM', 'brain', () => (
          <>
          <View style={styles.optionsRow}>
            {LLM_PROVIDERS.map((p) => (
              <TouchableOpacity
                key={p}
                style={[styles.optionChip, settings.llmProvider === p && styles.optionChipActive]}
                onPress={() => {
                  updateSettings({ llmProvider: p });
                  const models = LLM_MODELS.filter(m => m.provider === p);
                  if (models.length > 0) {
                    updateSettings({ llmModel: models[0].id });
                  }
                }}
              >
                <Text style={[styles.optionText, settings.llmProvider === p && styles.optionTextActive]}>
                  {p.charAt(0).toUpperCase() + p.slice(1)}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
          <Text style={styles.subsectionTitle}>Modelo</Text>
          <View style={styles.optionsRow}>
            {modelsForProvider.map((model) => (
              <TouchableOpacity
                key={model.id}
                style={[styles.optionChip, settings.llmModel === model.id && styles.optionChipActive]}
                onPress={() => handleSelectLLMModel(model.id)}
                disabled={switchingHermesModel !== null}
              >
                <Text style={[styles.optionText, settings.llmModel === model.id && styles.optionTextActive]}>
                  {switchingHermesModel === model.id ? 'Cambiando...' : model.name}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
          </>
        ), `${settings.llmProvider}/${settings.llmModel}`)}

        {renderSection('voiceMode', 'Modo de Voz', 'waveform', () => (
          <>
          <Text style={styles.hintText}>
            «Pipeline» usa tu flujo STT → LLM → TTS habitual. «Grok Realtime» conversa directamente con Grok por voz (speech-to-speech) con sus voces nativas — requiere conexión y un build nativo (dev-client) en iOS.
          </Text>

          <View style={styles.optionsRow}>
            {([
              { id: 'pipeline', label: 'Pipeline (STT→LLM→TTS)' },
              { id: 'grok', label: 'Grok Realtime' },
            ] as const).map((mode) => (
              <TouchableOpacity
                key={mode.id}
                style={[styles.optionChip, settings.voiceMode === mode.id && styles.optionChipActive]}
                onPress={() => updateSettings({ voiceMode: mode.id })}
              >
                <Text style={[styles.optionText, settings.voiceMode === mode.id && styles.optionTextActive]}>
                  {mode.label}
                </Text>
              </TouchableOpacity>
            ))}
          </View>

          {settings.voiceMode === 'grok' ? (
            <>
              <Text style={styles.subsectionTitle}>Voz de Grok</Text>
              <View style={styles.optionsRow}>
                {GROK_VOICES.map((voice) => (
                  <TouchableOpacity
                    key={voice.id}
                    style={[styles.optionChip, settings.grokVoiceId === voice.id && styles.optionChipActive]}
                    onPress={() => updateSettings({ grokVoiceId: voice.id })}
                  >
                    <Text style={[styles.optionText, settings.grokVoiceId === voice.id && styles.optionTextActive]}>
                      {voice.name}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>
              <Text style={styles.hintText}>
                Voces nativas de xAI. Español (es-ES) soportado. La key de Grok vive en el servidor proxy — no se necesita ninguna key en el móvil.
              </Text>
            </>
          ) : null}
          </>
        ), settings.voiceMode === 'grok' ? `Grok · ${settings.grokVoiceId}` : 'Pipeline')}

        {renderSection('voice', 'Voz del Asistente', 'volume-high', () => (
          <>
          <Text style={styles.hintText}>
            Las voces de cada proveedor solo sonarán diferentes si ese proveedor está disponible en web/iOS y tiene credenciales válidas. En iPhone, las voces reales del sistema son las más fiables.
          </Text>

          {settings.ttsProvider === 'kokoro' ? (
            <View style={[styles.statusPanel, { borderColor: `${COLORS.success}40` }]}>
              <Text style={[styles.statusPanelLabel, { color: COLORS.success }]}>⚡ MODO BAJO COSTE / SUB-SEGUNDO</Text>
              <Text style={styles.statusPanelValue}>
                Kokoro streaming + ring buffer nativo. Solapa generación, síntesis y reproducción para mínima latencia a coste marginal ~0. Recomienda el preset «Ultra-rápido» y un dev-client nativo en iOS.
              </Text>
            </View>
          ) : null}

          {voicesByProvider.map(({ provider, voices }) => {
            const providerLabel = provider === 'native' ? 'Nativas'
              : provider === 'server' ? 'Server neural'
              : provider === 'kokoro' ? 'Kokoro (⚡ sub-segundo)'
              : provider === 'openai' ? 'OpenAI'
              : provider === 'elevenlabs' ? 'ElevenLabs'
              : 'MiniMax';
            return (
              <View key={provider} style={{ marginBottom: 8 }}>
                <Text style={styles.voiceGroupLabel}>{providerLabel}</Text>
                <View style={styles.optionsRow}>
                  {voices.map((voice) => (
                    <View key={voice.id} style={styles.voiceChipRow}>
                      <TouchableOpacity
                        style={[styles.optionChip, settings.ttsVoice === voice.id && styles.optionChipActive]}
                        onPress={() => updateSettings({
                          ttsProvider: provider,
                          ttsVoice: voice.id,
                          ttsNativeVoiceId: provider === 'native' && !voice.id.startsWith('native-')
                            ? voice.id
                            : settings.ttsNativeVoiceId,
                          ttsLanguage: voice.language === 'multi' ? settings.ttsLanguage : voice.language,
                        })}
                      >
                        <Text style={[styles.optionText, settings.ttsVoice === voice.id && styles.optionTextActive]}>
                          {voice.name}
                        </Text>
                      </TouchableOpacity>
                      <TouchableOpacity
                        onPress={() => handlePlayVoiceDemo(voice)}
                        disabled={playingVoice !== null}
                        style={styles.voiceDemoButton}
                      >
                        <Icon
                          name={playingVoice === voice.id ? 'loading' : 'play-circle-outline'}
                          size={22}
                          color={playingVoice === voice.id ? COLORS.accent : COLORS.textSecondary}
                        />
                      </TouchableOpacity>
                    </View>
                  ))}
                </View>
              </View>
            );
          })}

          {nativeVoices.length > 0 ? (
            <Text style={styles.hintText}>
              Detectadas {nativeVoices.length} voces reales del sistema. La app prioriza voces mejoradas/premium cuando no eliges una concreta.
            </Text>
          ) : null}
          </>
        ), `${settings.ttsProvider}/${settings.ttsVoice}`)}

        {renderSection('performance', 'Rendimiento y Naturalidad', 'speedometer', () => (
          <>
          <Text style={styles.hintText}>
            "Ultra-rápido" reduce espera y longitud de respuesta. "Natural" deja más aire y una voz más calmada.
          </Text>

          <Text style={styles.subsectionTitle}>Modo de respuesta</Text>
          <View style={styles.optionsRow}>
            {RESPONSE_STYLE_PRESETS.map((preset) => (
              <TouchableOpacity
                key={preset.id}
                style={[
                  styles.optionChip,
                  settings.responseStyle === preset.id && styles.optionChipActive,
                ]}
                onPress={() => applyResponseStylePreset(preset.id)}
              >
                <Text style={[
                  styles.optionText,
                  settings.responseStyle === preset.id && styles.optionTextActive,
                ]}>
                  {preset.name}
                </Text>
              </TouchableOpacity>
            ))}
          </View>

          <Text style={styles.subsectionTitle}>Workflow KAIRO</Text>
          <View style={styles.optionsRow}>
            {BOOLEAN_OPTIONS.map((enabled) => (
              <TouchableOpacity
                key={`continuous-${String(enabled)}`}
                style={[
                  styles.optionChip,
                  settings.continuousConversation === enabled && styles.optionChipActive,
                ]}
                onPress={() => updateSettings({ continuousConversation: enabled })}
              >
                <Text style={[
                  styles.optionText,
                  settings.continuousConversation === enabled && styles.optionTextActive,
                ]}>
                  {enabled ? 'Conversacion continua' : 'Solo KAIRO'}
                </Text>
              </TouchableOpacity>
            ))}
            {BOOLEAN_OPTIONS.map((enabled) => (
              <TouchableOpacity
                key={`interrupt-${String(enabled)}`}
                style={[
                  styles.optionChip,
                  settings.interruptSpeechWithButton === enabled && styles.optionChipActive,
                ]}
                onPress={() => updateSettings({ interruptSpeechWithButton: enabled })}
              >
                <Text style={[
                  styles.optionText,
                  settings.interruptSpeechWithButton === enabled && styles.optionTextActive,
                ]}>
                  {enabled ? 'Barge-in boton' : 'No interrumpir'}
                </Text>
              </TouchableOpacity>
            ))}
            {BOOLEAN_OPTIONS.map((enabled) => (
              <TouchableOpacity
                key={`wake-interrupt-${String(enabled)}`}
                style={[
                  styles.optionChip,
                  settings.interruptSpeechWithWakeWord === enabled && styles.optionChipActive,
                ]}
                onPress={() => updateSettings({ interruptSpeechWithWakeWord: enabled })}
              >
                <Text style={[
                  styles.optionText,
                  settings.interruptSpeechWithWakeWord === enabled && styles.optionTextActive,
                ]}>
                  {enabled ? 'Barge-in voz' : 'Wake no corta'}
                </Text>
              </TouchableOpacity>
            ))}
          </View>

          <Text style={styles.subsectionTitle}>Respuesta en directo</Text>
          <View style={styles.optionsRow}>
            {BOOLEAN_OPTIONS.map((enabled) => (
              <TouchableOpacity
                key={`streaming-${String(enabled)}`}
                style={[
                  styles.optionChip,
                  settings.streamingEnabled === enabled && styles.optionChipActive,
                ]}
                onPress={() => updateSettings({ streamingEnabled: enabled })}
              >
                <Text style={[
                  styles.optionText,
                  settings.streamingEnabled === enabled && styles.optionTextActive,
                ]}>
                  {enabled ? 'Streaming LLM' : 'Completa'}
                </Text>
              </TouchableOpacity>
            ))}
            {BOOLEAN_OPTIONS.map((enabled) => (
              <TouchableOpacity
                key={`chunked-tts-${String(enabled)}`}
                style={[
                  styles.optionChip,
                  settings.ttsChunkedPlaybackEnabled === enabled && styles.optionChipActive,
                ]}
                onPress={() => updateSettings({ ttsChunkedPlaybackEnabled: enabled })}
              >
                <Text style={[
                  styles.optionText,
                  settings.ttsChunkedPlaybackEnabled === enabled && styles.optionTextActive,
                ]}>
                  {enabled ? 'Voz por frases' : 'Voz al final'}
                </Text>
              </TouchableOpacity>
            ))}
          </View>

          <Text style={styles.subsectionTitle}>Corte de escucha</Text>
          <View style={styles.optionsRow}>
            {LISTENING_PRESETS.map((preset) => (
              <TouchableOpacity
                key={preset.label}
                style={[
                  styles.optionChip,
                  settings.silenceThresholdMs === preset.silence && styles.optionChipActive,
                ]}
                onPress={() => updateSettings({
                  silenceThresholdMs: preset.silence,
                  finalSilenceThresholdMs: preset.final,
                  sttStopTimeoutMs: preset.stop,
                })}
              >
                <Text style={[
                  styles.optionText,
                  settings.silenceThresholdMs === preset.silence && styles.optionTextActive,
                ]}>
                  {preset.label}
                </Text>
              </TouchableOpacity>
            ))}
          </View>

          <Text style={styles.subsectionTitle}>Timeout LLM</Text>
          <View style={styles.optionsRow}>
            {LLM_TIMEOUTS.map((timeout) => (
              <TouchableOpacity
                key={timeout}
                style={[
                  styles.optionChip,
                  settings.llmRequestTimeoutMs === timeout && styles.optionChipActive,
                ]}
                onPress={() => updateSettings({ llmRequestTimeoutMs: timeout })}
              >
                <Text style={[
                  styles.optionText,
                  settings.llmRequestTimeoutMs === timeout && styles.optionTextActive,
                ]}>
                  {`${timeout / 1000}s`}
                </Text>
              </TouchableOpacity>
            ))}
          </View>

          <Text style={styles.subsectionTitle}>Velocidad de voz</Text>
          <View style={styles.optionsRow}>
            {TTS_RATES.map((rate) => (
              <TouchableOpacity
                key={rate}
                style={[
                  styles.optionChip,
                  Math.abs(settings.ttsRate - rate) < 0.01 && styles.optionChipActive,
                ]}
                onPress={() => updateSettings({ ttsRate: rate })}
              >
                <Text style={[
                  styles.optionText,
                  Math.abs(settings.ttsRate - rate) < 0.01 && styles.optionTextActive,
                ]}>
                  {rate < 1 ? 'Suave' : rate < 1.15 ? 'Ágil' : 'Rápida'}
                </Text>
              </TouchableOpacity>
            ))}
          </View>

          <Text style={styles.subsectionTitle}>Tono</Text>
          <View style={styles.optionsRow}>
            {TTS_PITCHES.map((pitch) => (
              <TouchableOpacity
                key={pitch}
                style={[
                  styles.optionChip,
                  Math.abs(settings.ttsPitch - pitch) < 0.01 && styles.optionChipActive,
                ]}
                onPress={() => updateSettings({ ttsPitch: pitch })}
              >
                <Text style={[
                  styles.optionText,
                  Math.abs(settings.ttsPitch - pitch) < 0.01 && styles.optionTextActive,
                ]}>
                  {pitch < 1 ? 'Grave' : pitch > 1 ? 'Brillante' : 'Neutro'}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
          </>
        ), settings.responseStyle)}

        {renderSection('personality', 'Estilo de KAIRO', 'account-voice', () => (
          <>
          <Text style={styles.hintText}>
            Elige cómo responde KAIRO. El nombre visible de la IA es siempre la palabra de activación activa.
          </Text>
          <View style={styles.optionsRow}>
            {PERSONALITY_PRESETS.map((p) => (
              <TouchableOpacity
                key={p.id}
                style={[
                  styles.personalityCard,
                  settings.personalityId === p.id && styles.personalityCardActive,
                ]}
                onPress={() => updateSettings({ personalityId: p.id, systemPrompt: p.systemPromptPrefix })}
              >
                <Icon
                  name={p.icon as any}
                  size={22}
                  color={settings.personalityId === p.id ? COLORS.primary : COLORS.textSecondary}
                />
                <Text style={[
                  styles.personalityName,
                  settings.personalityId === p.id && { color: COLORS.primary },
                ]}>{p.name}</Text>
                <Text style={styles.personalityDesc}>{p.description}</Text>
              </TouchableOpacity>
            ))}
          </View>
          </>
        ), settings.personalityId)}

        {renderSection('prompt', 'System Prompt', 'script-text-outline', () => (
          <TextInput
            style={styles.promptInput}
            value={settings.systemPrompt}
            onChangeText={(text) => updateSettings({ systemPrompt: text })}
            multiline
            numberOfLines={4}
            placeholderTextColor={COLORS.textSecondary}
            placeholder="Instrucciones del sistema..."
          />
        ), 'Instrucciones base')}

        {renderSection('wake', 'Nombre y activación', 'microphone-outline', () => (
          <>
          <Text style={styles.hintText}>
            Esta palabra es el nombre visible de la IA y la frase para activarla por voz. El valor estable actual es KAIRO.
          </Text>
          <View style={styles.optionsRow}>
            {WAKE_WORD_PRESETS.map((preset) => {
              const isCustom = preset.id === 'custom';
              const isSelected = isCustom
                ? !WAKE_WORD_PRESETS.some(p => p.id !== 'custom' && p.phrase.toLowerCase() === settings.wakeWord.toLowerCase())
                : preset.phrase.toLowerCase() === settings.wakeWord.toLowerCase();
              return (
                <TouchableOpacity
                  key={preset.id}
                  style={[styles.optionChip, isSelected && styles.optionChipActive]}
                  onPress={() => {
                    if (!isCustom) {
                      updateSettings({ wakeWord: preset.phrase, wakeWordLang: preset.lang });
                    } else {
                      updateSettings({ wakeWordLang: 'es-ES' });
                    }
                  }}
                >
                  <Text style={[styles.optionText, isSelected && styles.optionTextActive]}>
                    {preset.label}
                  </Text>
                  {!isCustom && <Text style={styles.langHint}>{preset.lang === 'es-ES' ? '🇪🇸' : '🇬🇧'}</Text>}
                </TouchableOpacity>
              );
            })}
          </View>
          {!WAKE_WORD_PRESETS.some(p => p.id !== 'custom' && p.phrase.toLowerCase() === settings.wakeWord.toLowerCase()) && (
            <TextInput
              style={[styles.wakeWordInput, { marginTop: 8 }]}
              value={settings.wakeWord}
              onChangeText={(text) => updateSettings({ wakeWord: text })}
              placeholder="Tu frase personalizada..."
              placeholderTextColor={COLORS.textSecondary}
              autoCapitalize="sentences"
            />
          )}

          <Text style={styles.subsectionTitle}>Rearme de KAIRO</Text>
          <View style={styles.optionsRow}>
            {WAKE_REARM_PRESETS.map((preset) => (
              <TouchableOpacity
                key={preset.label}
                style={[
                  styles.optionChip,
                  settings.wakeWordResumeDelayMs === preset.resume && styles.optionChipActive,
                ]}
                onPress={() => updateSettings({
                  wakeWordResumeDelayMs: preset.resume,
                  wakeWordCooldownMs: preset.cooldown,
                  wakeWordMinTriggerIntervalMs: preset.trigger,
                })}
              >
                <Text style={[
                  styles.optionText,
                  settings.wakeWordResumeDelayMs === preset.resume && styles.optionTextActive,
                ]}>
                  {preset.label}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
          </>
        ), `"${settings.wakeWord}"`)}

        {renderSection('bluetooth', 'Bluetooth', 'bluetooth-connect', () => (
          <>
          <Text style={styles.hintText}>
            Activa la reconexión automática para que la app intente volver a enlazar con las gafas nada más abrirse.
          </Text>

          <Text style={styles.subsectionTitle}>Reconexión automática</Text>
          <View style={styles.optionsRow}>
            {BOOLEAN_OPTIONS.map((enabled) => (
              <TouchableOpacity
                key={String(enabled)}
                style={[
                  styles.optionChip,
                  settings.autoConnectBluetooth === enabled && styles.optionChipActive,
                ]}
                onPress={() => updateSettings({ autoConnectBluetooth: enabled })}
              >
                <Text style={[
                  styles.optionText,
                  settings.autoConnectBluetooth === enabled && styles.optionTextActive,
                ]}>
                  {enabled ? 'Activada' : 'Desactivada'}
                </Text>
              </TouchableOpacity>
            ))}
          </View>

          <Text style={styles.subsectionTitle}>Búsqueda corta al abrir</Text>
          <View style={styles.optionsRow}>
            {BOOLEAN_OPTIONS.map((enabled) => (
              <TouchableOpacity
                key={`scan-${String(enabled)}`}
                style={[
                  styles.optionChip,
                  settings.autoScanBluetoothOnLaunch === enabled && styles.optionChipActive,
                ]}
                onPress={() => updateSettings({ autoScanBluetoothOnLaunch: enabled })}
              >
                <Text style={[
                  styles.optionText,
                  settings.autoScanBluetoothOnLaunch === enabled && styles.optionTextActive,
                ]}>
                  {enabled ? 'Sí' : 'No'}
                </Text>
              </TouchableOpacity>
            ))}
          </View>

          <Text style={styles.subsectionTitle}>Duración del auto-scan</Text>
          <View style={styles.optionsRow}>
            {BLUETOOTH_SCAN_DURATIONS.map((duration) => (
              <TouchableOpacity
                key={duration}
                style={[
                  styles.optionChip,
                  settings.bluetoothAutoScanDurationMs === duration && styles.optionChipActive,
                ]}
                onPress={() => updateSettings({ bluetoothAutoScanDurationMs: duration })}
              >
                <Text style={[
                  styles.optionText,
                  settings.bluetoothAutoScanDurationMs === duration && styles.optionTextActive,
                ]}>
                  {`${(duration / 1000).toFixed(1)}s`}
                </Text>
              </TouchableOpacity>
            ))}
          </View>

          <Text style={styles.subsectionTitle}>Vigilancia con app abierta</Text>
          <View style={styles.optionsRow}>
            {BLUETOOTH_RECONNECT_INTERVALS.map((intervalMs) => (
              <TouchableOpacity
                key={intervalMs}
                style={[
                  styles.optionChip,
                  settings.bluetoothAutoReconnectIntervalMs === intervalMs && styles.optionChipActive,
                ]}
                onPress={() => updateSettings({ bluetoothAutoReconnectIntervalMs: intervalMs })}
              >
                <Text style={[
                  styles.optionText,
                  settings.bluetoothAutoReconnectIntervalMs === intervalMs && styles.optionTextActive,
                ]}>
                  {`${(intervalMs / 1000).toFixed(0)}s`}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
          </>
        ), settings.autoConnectBluetooth ? 'Auto-connect activo' : 'Manual')}

        {renderSection('diagnostics', 'Diagnósticos', 'stethoscope', () => (
          <>
          <TouchableOpacity
            style={styles.diagButton}
            onPress={handleTestPipeline}
            disabled={testingPipeline}
          >
            <Icon name="flask-outline" size={20} color={COLORS.primary} />
            <Text style={styles.diagButtonText}>
              {testingPipeline ? 'Probando...' : 'Probar Pipeline (LLM)'}
            </Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={styles.diagButton}
            onPress={handleCheckHermes}
            disabled={checkingHermes}
          >
            <Icon name="server-network" size={20} color={COLORS.primary} />
            <Text style={styles.diagButtonText}>
              {checkingHermes ? 'Comprobando Hermes...' : 'Estado Hermes'}
            </Text>
          </TouchableOpacity>

          <View style={styles.statusPanel}>
            <Text style={styles.statusPanelLabel}>Hermes</Text>
            <Text style={styles.statusPanelValue}>{hermesSummary}</Text>
          </View>

          <TouchableOpacity
            style={styles.diagButton}
            onPress={openLogModal}
          >
            <Icon name="text-box-outline" size={20} color={COLORS.primary} />
            <Text style={styles.diagButtonText}>Ver Logs ({logCount})</Text>
          </TouchableOpacity>

          <Text style={styles.subsectionTitle}>Guardar audio STT</Text>
          <View style={styles.optionsRow}>
            {BOOLEAN_OPTIONS.map((enabled) => (
              <TouchableOpacity
                key={`speech-debug-${String(enabled)}`}
                style={[
                  styles.optionChip,
                  settings.speechDebugAudioEnabled === enabled && styles.optionChipActive,
                ]}
                onPress={() => updateSettings({ speechDebugAudioEnabled: enabled })}
              >
                <Text style={[
                  styles.optionText,
                  settings.speechDebugAudioEnabled === enabled && styles.optionTextActive,
                ]}>
                  {enabled ? 'Sí' : 'No'}
                </Text>
              </TouchableOpacity>
            ))}
          </View>

          <Text style={styles.hintText}>
            Proveedor: {settings.llmProvider} · Modelo: {settings.llmModel} · IA/Wake word: {settings.wakeWord}
          </Text>
          </>
        ), `${logCount} logs`)}
      </ScrollView>

      {/* Log Viewer Modal */}
      <Modal visible={logModalVisible} animationType="slide" presentationStyle="pageSheet">
        <SafeAreaView style={styles.modalContainer}>
          <View style={styles.modalHeader}>
            <Text style={styles.modalTitle}>Logs ({logs.length})</Text>
            <View style={styles.modalActions}>
              <TouchableOpacity onPress={handleExportLogs}>
                <Icon name="share-variant" size={22} color={COLORS.primary} />
              </TouchableOpacity>
              <TouchableOpacity onPress={handleClearLogs}>
                <Icon name="delete-outline" size={22} color={COLORS.error} />
              </TouchableOpacity>
              <TouchableOpacity onPress={() => setLogModalVisible(false)}>
                <Icon name="close" size={24} color={COLORS.text} />
              </TouchableOpacity>
            </View>
          </View>

          <FlatList
            data={logs}
            keyExtractor={keyLogEntry}
            renderItem={renderLogEntry}
            initialNumToRender={30}
            maxToRenderPerBatch={30}
            windowSize={7}
            contentContainerStyle={{ padding: 12 }}
            showsVerticalScrollIndicator={false}
          />
        </SafeAreaView>
      </Modal>
    </SafeAreaView>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: COLORS.background,
  },
  content: {
    padding: 16,
    paddingBottom: 40,
  },
  title: {
    fontSize: 24,
    fontWeight: '700',
    color: COLORS.text,
  },
  consoleHeader: {
    backgroundColor: COLORS.card,
    borderRadius: 12,
    padding: 14,
    marginBottom: 16,
    borderWidth: 1,
    borderColor: `${COLORS.primary}30`,
  },
  headerTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  headerSubtitle: {
    fontSize: 11,
    color: COLORS.textSecondary,
    marginTop: 2,
  },
  headerMetrics: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 12,
  },
  metricPill: {
    flex: 1,
    backgroundColor: COLORS.background,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  metricLabel: {
    fontSize: 9,
    color: COLORS.textMuted,
    fontWeight: '800',
    letterSpacing: 0.5,
  },
  metricValue: {
    fontSize: 12,
    color: COLORS.primary,
    fontWeight: '800',
    marginTop: 2,
  },
  section: {
    backgroundColor: COLORS.surface,
    borderRadius: 12,
    marginBottom: 16,
    borderWidth: 1,
    borderColor: COLORS.border,
    overflow: 'hidden',
  },
  collapsibleHeader: {
    minHeight: 58,
    paddingHorizontal: 14,
    paddingVertical: 12,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
  },
  collapsibleTitleRow: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  sectionBody: {
    paddingHorizontal: 16,
    paddingBottom: 16,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: COLORS.border,
  },
  sectionHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 12,
  },
  sectionTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: COLORS.text,
  },
  sectionSubtitle: {
    fontSize: 11,
    color: COLORS.textMuted,
    marginTop: 2,
  },
  inlineSectionAction: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 12,
    marginBottom: 8,
  },
  iconOnlyButton: {
    width: 38,
    height: 38,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: COLORS.background,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  keyRow: {
    marginBottom: 12,
  },
  keyLabel: {
    fontSize: 13,
    color: COLORS.textSecondary,
    marginBottom: 4,
    fontWeight: '500',
  },
  keyInputRow: {
    flexDirection: 'row',
    gap: 8,
  },
  keyInput: {
    flex: 1,
    backgroundColor: COLORS.background,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    color: COLORS.text,
    fontSize: 14,
  },
  saveButton: {
    backgroundColor: COLORS.background,
    borderRadius: 8,
    padding: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pickerContainer: {
    backgroundColor: COLORS.background,
    borderRadius: 8,
    overflow: 'hidden',
  },
  picker: {
    color: COLORS.text,
  },
  optionsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  subsectionTitle: {
    fontSize: 13,
    fontWeight: '700',
    color: COLORS.text,
    marginTop: 12,
    marginBottom: 8,
  },
  optionChip: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 8,
    backgroundColor: COLORS.background,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  optionChipActive: {
    borderColor: COLORS.primary,
    backgroundColor: `${COLORS.primary}20`,
  },
  optionText: {
    fontSize: 13,
    color: COLORS.textSecondary,
    fontWeight: '500',
  },
  optionTextActive: {
    color: COLORS.primary,
    fontWeight: '700',
  },
  promptInput: {
    backgroundColor: COLORS.background,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    color: COLORS.text,
    fontSize: 14,
    minHeight: 100,
    textAlignVertical: 'top',
  },
  hintText: {
    fontSize: 12,
    color: COLORS.textSecondary,
    marginBottom: 8,
    lineHeight: 16,
  },
  wakeWordInput: {
    backgroundColor: COLORS.background,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    color: COLORS.text,
    fontSize: 14,
  },
  voiceGroupLabel: {
    fontSize: 12,
    fontWeight: '600',
    color: COLORS.textSecondary,
    marginBottom: 4,
    marginTop: 4,
  },
  langHint: {
    fontSize: 10,
    marginLeft: 2,
  },
  voiceChipRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  voiceDemoButton: {
    padding: 4,
  },
  personalityCard: {
    width: '47%',
    backgroundColor: COLORS.background,
    borderRadius: 10,
    padding: 12,
    borderWidth: 1,
    borderColor: COLORS.border,
    gap: 4,
  },
  personalityCardActive: {
    borderColor: COLORS.primary,
    backgroundColor: `${COLORS.primary}10`,
  },
  personalityName: {
    fontSize: 13,
    fontWeight: '700',
    color: COLORS.textSecondary,
    marginTop: 2,
  },
  personalityDesc: {
    fontSize: 11,
    color: COLORS.textMuted,
    lineHeight: 14,
  },
  diagButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: COLORS.background,
    borderRadius: 8,
    padding: 12,
    marginBottom: 8,
  },
  diagButtonText: {
    fontSize: 14,
    color: COLORS.text,
    fontWeight: '500',
  },
  statusPanel: {
    backgroundColor: COLORS.background,
    borderRadius: 8,
    padding: 12,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  statusPanelLabel: {
    fontSize: 10,
    color: COLORS.textMuted,
    fontWeight: '800',
    marginBottom: 4,
  },
  statusPanelValue: {
    fontSize: 13,
    color: COLORS.text,
    lineHeight: 18,
  },
  // Log viewer modal
  modalContainer: {
    flex: 1,
    backgroundColor: COLORS.background,
  },
  modalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
  },
  modalTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: COLORS.text,
  },
  modalActions: {
    flexDirection: 'row',
    gap: 16,
    alignItems: 'center',
  },
  logEntry: {
    marginBottom: 6,
    paddingBottom: 6,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: COLORS.border,
  },
  logMeta: {
    flexDirection: 'row',
    gap: 6,
    alignItems: 'center',
    marginBottom: 2,
  },
  logLevel: {
    fontSize: 10,
    fontWeight: '800',
    fontFamily: 'Courier',
  },
  logTag: {
    fontSize: 10,
    color: COLORS.textSecondary,
    fontFamily: 'Courier',
  },
  logTime: {
    fontSize: 10,
    color: COLORS.textSecondary,
    marginLeft: 'auto',
  },
  logMessage: {
    fontSize: 12,
    color: COLORS.text,
    lineHeight: 16,
  },
});
