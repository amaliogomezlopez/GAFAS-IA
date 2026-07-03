import React, { useState, useEffect, useRef } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TextInput,
  TouchableOpacity,
  Keyboard,
  Modal,
  FlatList,
  ActivityIndicator,
  Animated,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { MaterialCommunityIcons as Icon } from '@expo/vector-icons';
import { COLORS, LLM_MODELS, PERSONALITY_PRESETS, TTS_VOICES } from '../../constants';
import { useAppStore } from '../../stores';
import { useBluetooth } from '../../hooks/useBluetooth';
import { usePipeline } from '../../hooks/usePipeline';
import { useGrokVoice } from '../../hooks/useGrokVoice';
import { StatusBar } from '../../components/StatusBar';
import type { ConversationEntry } from '../../types';

interface BLEDevice {
  id: string;
  name: string | null;
}

/* ─── Arc Reactor Core ─────────────────────────── */
const ArcReactor: React.FC<{ state: string }> = ({ state }) => {
  const pulseAnim = useRef(new Animated.Value(1)).current;
  const glowAnim = useRef(new Animated.Value(0.3)).current;
  const rotateAnim = useRef(new Animated.Value(0)).current;

  const color =
    state === 'listening' ? COLORS.listening :
    state === 'processing' ? COLORS.processing :
    state === 'speaking' ? COLORS.speaking :
    COLORS.primary;

  useEffect(() => {
    if (Platform.OS === 'web' && state === 'idle') {
      glowAnim.setValue(0.45);
      pulseAnim.setValue(1);
      rotateAnim.setValue(0);
      return undefined;
    }

    if (state === 'idle') {
      // Gentle breathing
      const breathe = Animated.loop(
        Animated.sequence([
          Animated.timing(glowAnim, { toValue: 0.6, duration: 2000, useNativeDriver: true }),
          Animated.timing(glowAnim, { toValue: 0.3, duration: 2000, useNativeDriver: true }),
        ]),
      );
      breathe.start();
      pulseAnim.setValue(1);
      return () => breathe.stop();
    }
    if (state === 'listening') {
      const pulse = Animated.loop(
        Animated.sequence([
          Animated.timing(pulseAnim, { toValue: 1.12, duration: 500, useNativeDriver: true }),
          Animated.timing(pulseAnim, { toValue: 1, duration: 500, useNativeDriver: true }),
        ]),
      );
      const glow = Animated.loop(
        Animated.sequence([
          Animated.timing(glowAnim, { toValue: 1, duration: 400, useNativeDriver: true }),
          Animated.timing(glowAnim, { toValue: 0.5, duration: 400, useNativeDriver: true }),
        ]),
      );
      pulse.start();
      glow.start();
      return () => { pulse.stop(); glow.stop(); };
    }
    if (state === 'processing') {
      const spin = Animated.loop(
        Animated.timing(rotateAnim, { toValue: 1, duration: 2000, useNativeDriver: true }),
      );
      spin.start();
      glowAnim.setValue(0.8);
      pulseAnim.setValue(1);
      return () => { spin.stop(); rotateAnim.setValue(0); };
    }
    if (state === 'speaking') {
      const pulse = Animated.loop(
        Animated.sequence([
          Animated.timing(pulseAnim, { toValue: 1.06, duration: 300, useNativeDriver: true }),
          Animated.timing(pulseAnim, { toValue: 1, duration: 300, useNativeDriver: true }),
        ]),
      );
      pulse.start();
      glowAnim.setValue(0.9);
      return () => pulse.stop();
    }
  }, [state]);

  const rotate = rotateAnim.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '360deg'] });

  return (
    <View style={arcStyles.wrapper}>
      {/* Outer glow ring */}
      <Animated.View
        style={[
          arcStyles.glowRing,
          { borderColor: color, opacity: glowAnim, transform: [{ scale: pulseAnim }] },
        ]}
      />
      {/* Mid ring */}
      <Animated.View
        style={[
          arcStyles.midRing,
          { borderColor: color, transform: [{ rotate }, { scale: pulseAnim }] },
        ]}
      >
        <View style={[arcStyles.midRingNotch, { backgroundColor: color }]} />
        <View style={[arcStyles.midRingNotch, arcStyles.midRingNotch2, { backgroundColor: color }]} />
      </Animated.View>
      {/* Core */}
      <Animated.View
        style={[arcStyles.core, { backgroundColor: `${color}20`, borderColor: color, transform: [{ scale: pulseAnim }] }]}
      >
        <Icon
          name={
            state === 'listening' ? 'microphone' :
            state === 'processing' ? 'brain' :
            state === 'speaking' ? 'volume-high' :
            'shield-half-full'
          }
          size={32}
          color={color}
        />
      </Animated.View>
    </View>
  );
};

const arcStyles = StyleSheet.create({
  wrapper: {
    width: 140,
    height: 140,
    alignItems: 'center',
    justifyContent: 'center',
  },
  glowRing: {
    position: 'absolute',
    width: 140,
    height: 140,
    borderRadius: 70,
    borderWidth: 1.5,
  },
  midRing: {
    position: 'absolute',
    width: 110,
    height: 110,
    borderRadius: 55,
    borderWidth: 2,
    borderStyle: 'dashed',
    alignItems: 'center',
    justifyContent: 'center',
  },
  midRingNotch: {
    position: 'absolute',
    width: 8,
    height: 8,
    borderRadius: 4,
    top: -4,
  },
  midRingNotch2: {
    top: undefined,
    bottom: -4,
  },
  core: {
    width: 72,
    height: 72,
    borderRadius: 36,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
});

/* ─── Latency HUD ─────────────────────────── */
const LatencyHUD: React.FC = () => {
  const latencyMetrics = useAppStore((s) => s.latencyMetrics);
  if (!latencyMetrics) return null;

  const items = [
    { label: 'STT', value: latencyMetrics.sttMs, color: COLORS.listening },
    { label: 'LLM', value: latencyMetrics.llmMs, color: COLORS.processing },
    { label: 'TTS', value: latencyMetrics.ttsMs, color: COLORS.speaking },
  ];

  return (
    <View style={hudStyles.row}>
      {items.map((item) => (
        <View key={item.label} style={hudStyles.item}>
          <Text style={[hudStyles.label, { color: item.color }]}>{item.label}</Text>
          <Text style={hudStyles.value}>
            {item.value != null ? `${(item.value / 1000).toFixed(1)}s` : '–'}
          </Text>
        </View>
      ))}
      <View style={hudStyles.item}>
        <Text style={[hudStyles.label, { color: COLORS.accent }]}>TOT</Text>
        <Text style={[hudStyles.value, { color: COLORS.accent }]}>
          {latencyMetrics.totalMs != null ? `${(latencyMetrics.totalMs / 1000).toFixed(1)}s` : '–'}
        </Text>
      </View>
    </View>
  );
};

const hudStyles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 16,
    marginTop: 8,
    paddingVertical: 6,
    paddingHorizontal: 12,
    backgroundColor: COLORS.surface,
    borderRadius: 8,
    alignSelf: 'center',
  },
  item: { alignItems: 'center' },
  label: { fontSize: 9, fontWeight: '700', letterSpacing: 1 },
  value: { fontSize: 12, color: COLORS.text, fontWeight: '600', marginTop: 1 },
});

const CockpitCell: React.FC<{ icon: string; label: string; value: string; tone?: string }> = ({ icon, label, value, tone }) => (
  <View style={cockpitStyles.cell}>
    <Icon name={icon as any} size={16} color={tone || COLORS.textSecondary} />
    <Text style={cockpitStyles.cellLabel}>{label}</Text>
    <Text style={[cockpitStyles.cellValue, tone ? { color: tone } : null]} numberOfLines={1}>{value}</Text>
  </View>
);

const cockpitStyles = StyleSheet.create({
  grid: {
    width: '100%',
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginTop: 18,
  },
  cell: {
    width: '48%',
    minHeight: 70,
    backgroundColor: COLORS.surface,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: COLORS.border,
    padding: 10,
    justifyContent: 'space-between',
  },
  cellLabel: {
    fontSize: 9,
    color: COLORS.textMuted,
    fontWeight: '800',
    marginTop: 6,
  },
  cellValue: {
    fontSize: 12,
    color: COLORS.text,
    fontWeight: '700',
    marginTop: 2,
  },
  liveStrip: {
    marginHorizontal: 16,
    marginBottom: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 8,
    backgroundColor: COLORS.surface,
    borderWidth: 1,
    borderColor: COLORS.border,
    gap: 8,
  },
  stepRow: {
    flexDirection: 'row',
    gap: 6,
  },
  step: {
    flex: 1,
    height: 4,
    borderRadius: 2,
    backgroundColor: COLORS.border,
  },
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  metaText: {
    flex: 1,
    color: COLORS.textSecondary,
    fontSize: 11,
    fontWeight: '700',
  },
});

/* ─── State Label ─────────────────────────── */
const STATE_LABELS: Record<string, { label: string; sub: string }> = {
  idle: { label: 'En espera', sub: 'Di la palabra de activación o pulsa el reactor' },
  listening: { label: 'Escuchando', sub: 'Habla ahora — se parará al detectar silencio' },
  processing: { label: 'Procesando', sub: 'Analizando con IA...' },
  speaking: { label: 'Hablando', sub: 'Di KAIRO para interrumpir' },
};

const STATE_ORDER = ['listening', 'processing', 'speaking'];

/* ─── Home Screen ─────────────────────────── */
export const HomeScreen: React.FC = () => {
  const {
    pipelineState,
    currentTranscription,
    interimTranscription,
    currentResponse,
    error,
    isBluetoothConnected,
    bluetoothDeviceName,
    bluetoothBattery,
    settings,
    chatSessions,
    activeSessionId,
    clearError,
  } = useAppStore();

  const { scanForDevices, connectToDevice, disconnect, isScanning, isAutoConnecting, bleAvailable } = useBluetooth();
  const { startListening, stopListeningAndProcess, sendTextMessage, forceStop, interruptAndListen } = usePipeline();
  const { startSession: startGrokSession, stopSession: stopGrokSession, isActive: isGrokActive } = useGrokVoice();
  const [textInput, setTextInput] = useState('');
  const [showBLEModal, setShowBLEModal] = useState(false);
  const [foundDevices, setFoundDevices] = useState<BLEDevice[]>([]);
  const [connecting, setConnecting] = useState<string | null>(null);
  const scrollRef = useRef<ScrollView>(null);

  // Get active session entries (oldest first for chat layout)
  const activeSession = chatSessions.find(s => s.id === activeSessionId);
  const sessionEntries: ConversationEntry[] = activeSession
    ? [...activeSession.entries].reverse()
    : [];

  // KAIRO identity
  const personality = PERSONALITY_PRESETS.find(p => p.id === settings.personalityId) || PERSONALITY_PRESETS[0];
  const aiLabel = settings.wakeWord.trim().toUpperCase() || 'KAIRO';
  const modelName = LLM_MODELS.find((model) => model.provider === settings.llmProvider && model.id === settings.llmModel)?.name || settings.llmModel;
  const voiceName = TTS_VOICES.find((voice) => voice.provider === settings.ttsProvider && voice.id === settings.ttsVoice)?.name || settings.ttsVoice;
  const activeStepIndex = STATE_ORDER.indexOf(pipelineState);
  const streamingMode = settings.streamingEnabled && settings.ttsChunkedPlaybackEnabled ? 'Streaming + frases' : settings.streamingEnabled ? 'Streaming' : 'Completa';

  const handleReactorPress = () => {
    clearError();
    // Grok realtime mode: the reactor toggles the whole voice session.
    if (settings.voiceMode === 'grok') {
      if (isGrokActive()) {
        stopGrokSession();
      } else if (pipelineState === 'idle') {
        startGrokSession();
      }
      return;
    }
    // Pipeline mode (the existing STT → LLM → TTS flow).
    if (pipelineState === 'listening') {
      stopListeningAndProcess();
    } else if (pipelineState !== 'idle' && settings.interruptSpeechWithButton) {
      interruptAndListen();
    } else if (pipelineState === 'idle') {
      startListening();
    }
  };

  const handleForceStop = () => {
    if (settings.voiceMode === 'grok') {
      stopGrokSession();
      return;
    }
    forceStop();
  };

  const handleSendText = () => {
    const trimmed = textInput.trim();
    if (!trimmed || pipelineState !== 'idle') return;
    clearError();
    Keyboard.dismiss();
    setTextInput('');
    sendTextMessage(trimmed);
  };

  const handleOpenBLEScan = async () => {
    setShowBLEModal(true);
    setFoundDevices([]);
    const devices = await scanForDevices();
    const mapped: BLEDevice[] = devices
      .filter((d: any) => d.name)
      .map((d: any) => ({ id: d.id, name: d.name }));
    setFoundDevices(mapped);
  };

  const handleConnectDevice = async (deviceId: string) => {
    setConnecting(deviceId);
    const ok = await connectToDevice(deviceId);
    setConnecting(null);
    if (ok) setShowBLEModal(false);
  };

  const isInProgress = pipelineState !== 'idle';
  const hasInProgressContent = !!(interimTranscription || currentTranscription || currentResponse);
  const hasConversation = sessionEntries.length > 0 || hasInProgressContent || !!error;
  const canForceStop = pipelineState === 'processing' || pipelineState === 'speaking';
  const canInterrupt = isInProgress && pipelineState !== 'listening' && settings.interruptSpeechWithButton;

  const stateColor =
    pipelineState === 'listening' ? COLORS.listening :
    pipelineState === 'processing' ? COLORS.processing :
    pipelineState === 'speaking' ? COLORS.speaking :
    COLORS.primary;

  const stateInfo = STATE_LABELS[pipelineState] || STATE_LABELS.idle;
  const statusMeta = `${settings.llmProvider}/${modelName.replace(/^Hermes \//, '')}`;

  return (
    <SafeAreaView style={styles.container}>
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        {/* ── Top Info Bar: KAIRO + Battery ── */}
        <View style={styles.topInfoBar}>
          <View style={styles.personalityChip}>
            <Icon name={personality.icon as any} size={16} color={COLORS.primary} />
            <Text style={styles.personalityChipText}>{aiLabel}</Text>
          </View>
          {settings.continuousConversation && (
            <View style={styles.followUpChip}>
              <Icon name="autorenew" size={14} color={COLORS.success} />
              <Text style={styles.followUpChipText}>Continuo</Text>
            </View>
          )}
          <View style={styles.modelChip}>
            <Icon name="brain" size={14} color={COLORS.processing} />
            <Text style={styles.modelChipText} numberOfLines={1}>{modelName}</Text>
          </View>
          <View style={styles.voiceChip}>
            <Icon name="waveform" size={14} color={COLORS.speaking} />
            <Text style={styles.voiceChipText} numberOfLines={1}>{voiceName}</Text>
          </View>
          {settings.voiceMode === 'grok' ? (
            <View style={[styles.followUpChip, { borderColor: `${COLORS.accent}60` }]}>
              <Icon name="lightning-bolt" size={14} color={COLORS.accent} />
              <Text style={[styles.followUpChipText, { color: COLORS.accent }]}>
                {isGrokActive() ? 'GROK LIVE' : 'Grok'}
              </Text>
            </View>
          ) : null}
          <View style={[
            styles.connectionChip,
            isBluetoothConnected ? styles.connectionChipOk : styles.connectionChipSearching,
          ]}>
            <Icon
              name={isBluetoothConnected ? 'bluetooth-connect' : isAutoConnecting ? 'radar' : 'bluetooth-off'}
              size={14}
              color={isBluetoothConnected ? COLORS.success : isAutoConnecting ? COLORS.warning : COLORS.textSecondary}
            />
            <Text style={[
              styles.connectionChipText,
              { color: isBluetoothConnected ? COLORS.success : isAutoConnecting ? COLORS.warning : COLORS.textSecondary },
            ]}>
              {isBluetoothConnected ? 'Gafas OK' : isAutoConnecting ? 'Buscando' : 'Auto BLE'}
            </Text>
          </View>
          {isBluetoothConnected && bluetoothBattery != null && (
            <View style={styles.batteryChip}>
              <Icon
                name={bluetoothBattery >= 50 ? 'battery' : bluetoothBattery >= 20 ? 'battery-30' : 'battery-alert-variant-outline'}
                size={16}
                color={bluetoothBattery <= 20 ? COLORS.error : COLORS.success}
              />
              <Text style={[styles.batteryChipText, { color: bluetoothBattery <= 20 ? COLORS.error : COLORS.success }]}>
                {bluetoothBattery}%
              </Text>
            </View>
          )}
        </View>

        {/* Top HUD bar */}
        <TouchableOpacity
          onPress={isBluetoothConnected ? () => disconnect() : handleOpenBLEScan}
          activeOpacity={0.7}
        >
          <StatusBar
            pipelineState={pipelineState}
            isBluetoothConnected={isBluetoothConnected}
            bluetoothDeviceName={bluetoothDeviceName}
            batteryLevel={bluetoothBattery}
          />
        </TouchableOpacity>

        {/* ── Live Transcription Bar ── */}
        {pipelineState === 'listening' && (
          <View style={styles.liveTranscriptionBar}>
            <View style={styles.liveTranscriptionDot} />
            <Text style={styles.liveTranscriptionLabel}>EN VIVO</Text>
            <Text style={styles.liveTranscriptionText} numberOfLines={2}>
              {interimTranscription || 'Escuchando...'}
            </Text>
          </View>
        )}

        {Platform.OS !== 'web' && pipelineState === 'speaking' && settings.interruptSpeechWithWakeWord && (
          <View style={styles.interruptHintBar}>
            <Icon name="microphone-plus" size={15} color={COLORS.primary} />
            <Text style={styles.interruptHintText} numberOfLines={1}>
              Di "{settings.wakeWord}" para cortar y hablar encima
            </Text>
          </View>
        )}

        <View style={cockpitStyles.liveStrip}>
          <View style={cockpitStyles.stepRow}>
            {STATE_ORDER.map((step, index) => (
              <View
                key={step}
                style={[
                  cockpitStyles.step,
                  activeStepIndex >= index && { backgroundColor: stateColor },
                  pipelineState === 'idle' && index === 0 && { backgroundColor: COLORS.primaryDark },
                ]}
              />
            ))}
          </View>
          <View style={cockpitStyles.metaRow}>
            <Text style={cockpitStyles.metaText} numberOfLines={1}>
              {stateInfo.label} · {streamingMode}
            </Text>
            <Text style={[cockpitStyles.metaText, { textAlign: 'right', color: stateColor }]} numberOfLines={1}>
              {statusMeta}
            </Text>
          </View>
        </View>

        <View style={styles.mainArea}>
          {hasConversation ? (
            /* ── Conversation View ── */
            <ScrollView
              ref={scrollRef}
              style={styles.conversationScroll}
              contentContainerStyle={styles.conversationContent}
              onContentSizeChange={() => scrollRef.current?.scrollToEnd({ animated: true })}
            >
              {/* Previous session entries */}
              {sessionEntries.map((entry: ConversationEntry) => (
                <View key={entry.id}>
                  <View style={styles.chatBubbleUser}>
                    <Text style={styles.chatBubbleLabel}>TÚ</Text>
                    <Text style={styles.chatBubbleText}>{entry.userMessage.content}</Text>
                  </View>
                  <View style={styles.chatBubbleAI}>
                    <Text style={[styles.chatBubbleLabel, { color: COLORS.primary }]}>{aiLabel}</Text>
                    <Text style={styles.chatBubbleText}>{entry.assistantMessage.content}</Text>
                  </View>
                </View>
              ))}

              {/* Error bubble */}
              {error && (
                <View style={styles.errorBubble}>
                  <Icon name="alert-circle" size={16} color={COLORS.error} />
                  <Text style={styles.errorText}>{error}</Text>
                </View>
              )}

              {/* Current in-progress turn */}
              {(currentTranscription || interimTranscription) && (
                <View style={styles.chatBubbleUser}>
                  <Text style={styles.chatBubbleLabel}>TÚ</Text>
                  <Text style={[
                    styles.chatBubbleText,
                    !currentTranscription && { color: COLORS.textSecondary, fontStyle: 'italic' },
                  ]}>
                    {currentTranscription || interimTranscription}
                  </Text>
                </View>
              )}

              {currentResponse ? (
                <View style={styles.chatBubbleAI}>
                  <Text style={[styles.chatBubbleLabel, { color: COLORS.primary }]}>{aiLabel}</Text>
                  <Text style={styles.chatBubbleText}>{currentResponse}</Text>
                </View>
              ) : null}

              {pipelineState === 'processing' && !currentResponse && (
                <View style={styles.chatBubbleAI}>
                  <Text style={[styles.chatBubbleLabel, { color: COLORS.primary }]}>{aiLabel}</Text>
                  <ActivityIndicator size="small" color={COLORS.primary} style={{ alignSelf: 'flex-start' }} />
                </View>
              )}
            </ScrollView>
          ) : (
            /* ── Hero / Idle State ── */
            <View style={styles.heroSection}>
              <TouchableOpacity
                onPress={handleReactorPress}
                activeOpacity={0.7}
              >
                <ArcReactor state={pipelineState} />
              </TouchableOpacity>

              <Text style={[styles.stateLabel, { color: stateColor }]}>{stateInfo.label}</Text>
              <Text style={styles.stateSubtitle}>
                {Platform.OS === 'web' && pipelineState === 'idle'
                  ? 'Pulsa el reactor o Hablar para activar el micro'
                  : stateInfo.sub}
              </Text>

              <LatencyHUD />

              <View style={cockpitStyles.grid}>
                <CockpitCell
                  icon="bluetooth-connect"
                  label="GAFAS"
                  value={isBluetoothConnected ? bluetoothDeviceName || 'Conectadas' : isAutoConnecting ? 'Buscando' : 'Sin enlace'}
                  tone={isBluetoothConnected ? COLORS.success : isAutoConnecting ? COLORS.warning : COLORS.textSecondary}
                />
                <CockpitCell
                  icon="brain"
                  label="MODELO"
                  value={modelName}
                  tone={COLORS.processing}
                />
                <CockpitCell
                  icon="waveform"
                  label="VOZ"
                  value={voiceName}
                  tone={COLORS.speaking}
                />
                <CockpitCell
                  icon="speedometer"
                  label="MODO"
                  value={streamingMode}
                  tone={COLORS.primary}
                />
              </View>

              {/* Quick actions */}
              <View style={styles.quickActions}>
                <TouchableOpacity
                  style={[styles.quickBtn, isBluetoothConnected && styles.quickBtnActive]}
                  onPress={isBluetoothConnected ? () => disconnect() : handleOpenBLEScan}
                  activeOpacity={0.7}
                >
                  <Icon
                    name={isBluetoothConnected ? 'bluetooth-connect' : isAutoConnecting ? 'radar' : 'bluetooth'}
                    size={22}
                    color={isBluetoothConnected ? COLORS.success : isAutoConnecting ? COLORS.warning : COLORS.textSecondary}
                  />
                  <Text style={[
                    styles.quickBtnLabel,
                    isBluetoothConnected && { color: COLORS.success },
                    isAutoConnecting && { color: COLORS.warning },
                  ]}>
                    {isBluetoothConnected ? 'BLE OK' : isAutoConnecting ? 'Buscando' : 'Conectar'}
                  </Text>
                </TouchableOpacity>

                <TouchableOpacity
                  style={[styles.quickBtn, styles.quickBtnPrimary]}
                  onPress={handleReactorPress}
                  disabled={pipelineState !== 'idle'}
                  activeOpacity={0.7}
                >
                  <Icon name="microphone" size={22} color={COLORS.primary} />
                  <Text style={[styles.quickBtnLabel, { color: COLORS.primary }]}>Hablar</Text>
                </TouchableOpacity>
              </View>
            </View>
          )}
        </View>

        {/* Floating controls when in conversation */}
        {hasConversation && (
          <View style={styles.floatingControls}>
            {canForceStop && (
              <TouchableOpacity
                style={[
                  styles.forceStopBtn,
                  canInterrupt && { borderColor: COLORS.primary, backgroundColor: `${COLORS.primary}12` },
                ]}
                onPress={canInterrupt ? handleReactorPress : handleForceStop}
              >
                <Icon name={canInterrupt ? 'microphone-plus' : 'stop-circle'} size={20} color={canInterrupt ? COLORS.primary : COLORS.error} />
                <Text style={[styles.forceStopLabel, canInterrupt && { color: COLORS.primary }]}>
                  {canInterrupt ? 'Interrumpir' : 'Parar'}
                </Text>
              </TouchableOpacity>
            )}
            {!canForceStop && (
              <TouchableOpacity
                style={[styles.floatingMicBtn, { borderColor: stateColor }]}
                onPress={handleReactorPress}
                disabled={pipelineState !== 'idle'}
                activeOpacity={0.7}
              >
                <Icon name="microphone" size={20} color={stateColor} />
                <Text style={[styles.floatingMicLabel, { color: stateColor }]}>Hablar</Text>
              </TouchableOpacity>
            )}
          </View>
        )}

        {/* Text input bar */}
        <View style={styles.inputBar}>
          <TextInput
            style={styles.textInput}
            value={textInput}
            onChangeText={setTextInput}
            placeholder="Escribe un mensaje..."
            placeholderTextColor={COLORS.textMuted}
            editable={pipelineState === 'idle'}
            returnKeyType="send"
            onSubmitEditing={handleSendText}
          />
          <TouchableOpacity
            style={[styles.sendBtn, !textInput.trim() && { opacity: 0.4 }]}
            onPress={handleSendText}
            disabled={!textInput.trim() || pipelineState !== 'idle'}
          >
            <Icon name="send" size={20} color={textInput.trim() ? COLORS.primary : COLORS.textMuted} />
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>

      {/* BLE Scan Modal */}
      <Modal visible={showBLEModal} transparent animationType="slide">
        <View style={styles.modalOverlay}>
          <View style={styles.modalContent}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>Dispositivos BLE</Text>
              <TouchableOpacity onPress={() => setShowBLEModal(false)}>
                <Icon name="close" size={24} color={COLORS.text} />
              </TouchableOpacity>
            </View>

            {!bleAvailable && (
              <View style={styles.bleWarning}>
                <Icon name="alert" size={20} color={COLORS.warning} />
                <Text style={styles.bleWarningText}>
                  Bluetooth no disponible. Verifica que está activado en Ajustes.
                </Text>
              </View>
            )}

            {isScanning && (
              <View style={styles.scanningRow}>
                <ActivityIndicator color={COLORS.primary} />
                <Text style={styles.scanningText}>Buscando...</Text>
              </View>
            )}

            {!isScanning && foundDevices.length === 0 && bleAvailable && (
              <Text style={styles.noDevicesText}>No se encontraron dispositivos</Text>
            )}

            <FlatList
              data={foundDevices}
              keyExtractor={(item) => item.id}
              renderItem={({ item }) => (
                <TouchableOpacity
                  style={styles.deviceRow}
                  onPress={() => handleConnectDevice(item.id)}
                  disabled={connecting !== null}
                >
                  <Icon name="bluetooth" size={20} color={COLORS.primary} />
                  <View style={styles.deviceInfo}>
                    <Text style={styles.deviceNameText}>{item.name || 'Unknown'}</Text>
                    <Text style={styles.deviceIdText}>{item.id}</Text>
                  </View>
                  {connecting === item.id ? (
                    <ActivityIndicator size="small" color={COLORS.primary} />
                  ) : (
                    <Icon name="link-variant" size={20} color={COLORS.textSecondary} />
                  )}
                </TouchableOpacity>
              )}
            />

            {bleAvailable && !isScanning && (
              <TouchableOpacity style={styles.rescanBtn} onPress={handleOpenBLEScan}>
                <Icon name="refresh" size={18} color={COLORS.primary} />
                <Text style={styles.rescanText}>Volver a buscar</Text>
              </TouchableOpacity>
            )}
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
};

/* ─── Styles ─────────────────────────── */
const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: COLORS.background,
  },
  mainArea: {
    flex: 1,
  },
  /* Hero / idle */
  heroSection: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 32,
    gap: 8,
  },
  stateLabel: {
    fontSize: 18,
    fontWeight: '700',
    letterSpacing: 1,
    marginTop: 12,
  },
  stateSubtitle: {
    fontSize: 12,
    color: COLORS.textSecondary,
    textAlign: 'center',
    lineHeight: 18,
  },
  quickActions: {
    flexDirection: 'row',
    gap: 12,
    marginTop: 20,
  },
  quickBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 10,
    backgroundColor: COLORS.surface,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  quickBtnActive: {
    borderColor: COLORS.success,
    backgroundColor: `${COLORS.success}10`,
  },
  quickBtnPrimary: {
    borderColor: COLORS.primary,
    backgroundColor: `${COLORS.primary}10`,
  },
  quickBtnLabel: {
    fontSize: 13,
    fontWeight: '600',
    color: COLORS.textSecondary,
  },
  /* Conversation */
  conversationScroll: {
    flex: 1,
  },
  conversationContent: {
    padding: 16,
    paddingBottom: 8,
    flexGrow: 1,
    justifyContent: 'flex-end',
  },
  chatBubbleUser: {
    alignSelf: 'flex-end',
    maxWidth: '85%',
    backgroundColor: `${COLORS.primary}15`,
    borderRadius: 14,
    borderTopRightRadius: 4,
    padding: 12,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: `${COLORS.primary}30`,
  },
  chatBubbleAI: {
    alignSelf: 'flex-start',
    maxWidth: '85%',
    backgroundColor: COLORS.surface,
    borderRadius: 14,
    borderTopLeftRadius: 4,
    padding: 12,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  chatBubbleLabel: {
    fontSize: 10,
    fontWeight: '800',
    color: COLORS.textSecondary,
    letterSpacing: 0.5,
    marginBottom: 4,
  },
  chatBubbleText: {
    fontSize: 15,
    color: COLORS.text,
    lineHeight: 22,
  },
  errorBubble: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: `${COLORS.error}12`,
    padding: 10,
    borderRadius: 10,
    borderLeftWidth: 3,
    borderLeftColor: COLORS.error,
    marginBottom: 10,
  },
  errorText: {
    flex: 1,
    color: COLORS.error,
    fontSize: 13,
  },
  /* Floating controls */
  floatingControls: {
    alignItems: 'center',
    paddingVertical: 6,
  },
  forceStopBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 18,
    paddingVertical: 8,
    borderRadius: 20,
    backgroundColor: `${COLORS.error}15`,
    borderWidth: 1,
    borderColor: COLORS.error,
  },
  forceStopLabel: {
    fontSize: 13,
    fontWeight: '700',
    color: COLORS.error,
  },
  floatingMicBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 20,
    paddingVertical: 8,
    borderRadius: 20,
    borderWidth: 1.5,
    backgroundColor: `${COLORS.primary}10`,
  },
  floatingMicLabel: {
    fontSize: 13,
    fontWeight: '600',
  },
  /* Input bar */
  inputBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 8,
    gap: 8,
  },
  textInput: {
    flex: 1,
    backgroundColor: COLORS.surface,
    borderRadius: 20,
    paddingHorizontal: 16,
    paddingVertical: 10,
    color: COLORS.text,
    fontSize: 14,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  sendBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: COLORS.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  /* BLE Modal */
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.7)',
    justifyContent: 'flex-end',
  },
  modalContent: {
    backgroundColor: COLORS.card,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    padding: 20,
    maxHeight: '60%',
  },
  modalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 16,
  },
  modalTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: COLORS.text,
  },
  bleWarning: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
    backgroundColor: `${COLORS.warning}15`,
    padding: 12,
    borderRadius: 10,
    marginBottom: 12,
  },
  bleWarningText: {
    flex: 1,
    fontSize: 12,
    color: COLORS.warning,
    lineHeight: 18,
  },
  scanningRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 12,
  },
  scanningText: {
    fontSize: 14,
    color: COLORS.textSecondary,
  },
  noDevicesText: {
    fontSize: 14,
    color: COLORS.textSecondary,
    textAlign: 'center',
    paddingVertical: 20,
  },
  deviceRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
  },
  deviceInfo: {
    flex: 1,
  },
  deviceNameText: {
    fontSize: 14,
    fontWeight: '600',
    color: COLORS.text,
  },
  deviceIdText: {
    fontSize: 11,
    color: COLORS.textSecondary,
    marginTop: 2,
  },
  rescanBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 12,
    marginTop: 8,
  },
  rescanText: {
    fontSize: 14,
    color: COLORS.primary,
    fontWeight: '600',
  },
  /* Top info bar */
  topInfoBar: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 6,
    gap: 8,
  },
  personalityChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: `${COLORS.primary}15`,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: `${COLORS.primary}30`,
  },
  personalityChipText: {
    fontSize: 11,
    fontWeight: '800',
    color: COLORS.primary,
    letterSpacing: 0.5,
  },
  wakeWordChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: `${COLORS.accent}12`,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: `${COLORS.accent}25`,
  },
  wakeWordChipText: {
    fontSize: 11,
    fontWeight: '600',
    color: COLORS.accent,
  },
  followUpChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: `${COLORS.success}12`,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: `${COLORS.success}25`,
  },
  followUpChipText: {
    fontSize: 11,
    fontWeight: '700',
    color: COLORS.success,
  },
  modelChip: {
    maxWidth: 170,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: `${COLORS.processing}12`,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: `${COLORS.processing}25`,
  },
  modelChipText: {
    flexShrink: 1,
    fontSize: 11,
    fontWeight: '700',
    color: COLORS.processing,
  },
  voiceChip: {
    maxWidth: 150,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: `${COLORS.speaking}12`,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: `${COLORS.speaking}25`,
  },
  voiceChipText: {
    flexShrink: 1,
    fontSize: 11,
    fontWeight: '700',
    color: COLORS.speaking,
  },
  connectionChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 12,
    borderWidth: 1,
  },
  connectionChipOk: {
    backgroundColor: `${COLORS.success}12`,
    borderColor: `${COLORS.success}25`,
  },
  connectionChipSearching: {
    backgroundColor: `${COLORS.warning}10`,
    borderColor: `${COLORS.warning}22`,
  },
  connectionChipText: {
    fontSize: 11,
    fontWeight: '700',
  },
  batteryChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    marginLeft: 'auto',
  },
  batteryChipText: {
    fontSize: 12,
    fontWeight: '700',
  },
  /* Live transcription bar */
  liveTranscriptionBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginHorizontal: 16,
    marginBottom: 4,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 10,
    backgroundColor: `${COLORS.listening}10`,
    borderWidth: 1,
    borderColor: `${COLORS.listening}30`,
  },
  liveTranscriptionDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: COLORS.listening,
  },
  liveTranscriptionLabel: {
    fontSize: 10,
    fontWeight: '800',
    color: COLORS.listening,
    letterSpacing: 0.5,
  },
  liveTranscriptionText: {
    flex: 1,
    fontSize: 13,
    color: COLORS.text,
    fontStyle: 'italic',
  },
  interruptHintBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginHorizontal: 16,
    marginBottom: 4,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 10,
    backgroundColor: `${COLORS.primary}10`,
    borderWidth: 1,
    borderColor: `${COLORS.primary}30`,
  },
  interruptHintText: {
    flex: 1,
    fontSize: 12,
    color: COLORS.primary,
    fontWeight: '700',
  },
});
