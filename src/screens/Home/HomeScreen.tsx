import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Animated,
  Easing,
  FlatList,
  Keyboard,
  KeyboardAvoidingView,
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
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { MaterialCommunityIcons as Icon } from '@expo/vector-icons';
import { COLORS, LLM_MODELS, RADIUS, SPACING, TTS_VOICES, withAlpha } from '../../constants';
import { useAppStore } from '../../stores';
import { useBluetooth } from '../../hooks/useBluetooth';
import { usePipeline } from '../../hooks/usePipeline';
import { useGrokVoice } from '../../hooks/useGrokVoice';
import { Button, IconButton, Pill } from '../../components';
import { formatSeconds, formatTime } from '../../utils/format';
import type { AppState, ConversationEntry } from '../../types';

type IconName = React.ComponentProps<typeof Icon>['name'];

interface BLEDevice {
  id: string;
  name: string | null;
}

const STATE_COLOR: Record<AppState, string> = {
  idle: COLORS.primary,
  listening: COLORS.listening,
  processing: COLORS.processing,
  speaking: COLORS.speaking,
  error: COLORS.error,
};

const STATE_ICON: Record<AppState, IconName> = {
  idle: 'shield-half-full',
  listening: 'microphone',
  processing: 'brain',
  speaking: 'volume-high',
  error: 'alert-circle-outline',
};

const SUGGESTIONS = [
  '¿Qué tiempo hará hoy?',
  'Recuérdame beber agua en una hora',
  'Resume las noticias de hoy',
  'Tradúceme “¿dónde está la estación?” al inglés',
];

/* ─── Arc Reactor Core ─────────────────────────── */
const ArcReactor: React.FC<{ state: AppState; size?: number }> = ({ state, size = 168 }) => {
  const pulseAnim = useRef(new Animated.Value(1)).current;
  const glowAnim = useRef(new Animated.Value(0.35)).current;
  const rotateAnim = useRef(new Animated.Value(0)).current;
  const color = STATE_COLOR[state];

  useEffect(() => {
    const loops: Animated.CompositeAnimation[] = [];
    const loop = (animation: Animated.CompositeAnimation) => {
      const looped = Animated.loop(animation);
      loops.push(looped);
      looped.start();
    };
    const timing = (value: Animated.Value, toValue: number, duration: number) =>
      Animated.timing(value, { toValue, duration, easing: Easing.inOut(Easing.quad), useNativeDriver: true });

    pulseAnim.setValue(1);
    rotateAnim.setValue(0);

    if (state === 'idle' || state === 'error') {
      loop(Animated.sequence([timing(glowAnim, 0.7, 2200), timing(glowAnim, 0.3, 2200)]));
      // Slow drift of the dashed ring keeps the idle screen alive without distracting.
      loop(Animated.timing(rotateAnim, { toValue: 1, duration: 24000, easing: Easing.linear, useNativeDriver: true }));
    } else if (state === 'listening') {
      loop(Animated.sequence([timing(pulseAnim, 1.1, 520), timing(pulseAnim, 1, 520)]));
      loop(Animated.sequence([timing(glowAnim, 1, 420), timing(glowAnim, 0.5, 420)]));
    } else if (state === 'processing') {
      glowAnim.setValue(0.85);
      loop(Animated.timing(rotateAnim, { toValue: 1, duration: 1600, easing: Easing.linear, useNativeDriver: true }));
    } else if (state === 'speaking') {
      glowAnim.setValue(0.9);
      loop(Animated.sequence([timing(pulseAnim, 1.06, 300), timing(pulseAnim, 1, 300)]));
    }
    return () => loops.forEach((animation) => animation.stop());
  }, [state, glowAnim, pulseAnim, rotateAnim]);

  const rotate = rotateAnim.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '360deg'] });
  const mid = size * 0.78;
  const core = size * 0.5;

  return (
    <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
      <Animated.View
        style={[
          arcStyles.ring,
          {
            width: size,
            height: size,
            borderRadius: size / 2,
            borderColor: color,
            backgroundColor: withAlpha(color, 0.04),
            opacity: glowAnim,
            transform: [{ scale: pulseAnim }],
          },
        ]}
      />
      <Animated.View
        style={[
          arcStyles.ring,
          arcStyles.dashed,
          { width: mid, height: mid, borderRadius: mid / 2, borderColor: withAlpha(color, 0.8), transform: [{ rotate }] },
        ]}
      >
        <View style={[arcStyles.notch, { backgroundColor: color, top: -4 }]} />
        <View style={[arcStyles.notch, { backgroundColor: color, bottom: -4 }]} />
      </Animated.View>
      <Animated.View
        style={[
          arcStyles.core,
          {
            width: core,
            height: core,
            borderRadius: core / 2,
            borderColor: color,
            backgroundColor: withAlpha(color, 0.14),
            shadowColor: color,
            transform: [{ scale: pulseAnim }],
          },
        ]}
      >
        <Icon name={STATE_ICON[state]} size={core * 0.42} color={color} />
      </Animated.View>
    </View>
  );
};

const arcStyles = StyleSheet.create({
  ring: {
    position: 'absolute',
    borderWidth: 1.5,
    alignItems: 'center',
    justifyContent: 'center',
  },
  dashed: {
    borderWidth: 2,
    borderStyle: 'dashed',
  },
  notch: {
    position: 'absolute',
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  core: {
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
    shadowOpacity: 0.6,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 0 },
    elevation: 8,
  },
});

/* ─── Chat bubbles ─────────────────────────── */
const Bubble: React.FC<{
  role: 'user' | 'assistant';
  label: string;
  text: string;
  time?: number;
  pending?: boolean;
}> = ({ role, label, text, time, pending }) => {
  const isUser = role === 'user';
  const handleLongPress = () => {
    if (!text) return;
    Share.share({ message: text }).catch(() => {});
  };
  return (
    <Pressable
      onLongPress={handleLongPress}
      delayLongPress={350}
      accessibilityHint="Mantén pulsado para compartir el mensaje"
      style={[styles.bubble, isUser ? styles.bubbleUser : styles.bubbleAI]}
    >
      <View style={styles.bubbleMeta}>
        <Text style={[styles.bubbleLabel, { color: isUser ? COLORS.textSecondary : COLORS.primary }]}>{label}</Text>
        {time ? <Text style={styles.bubbleTime}>{formatTime(time)}</Text> : null}
      </View>
      <Text style={[styles.bubbleText, pending && styles.bubbleTextPending]} selectable>
        {text}
      </Text>
    </Pressable>
  );
};

const TypingDots: React.FC<{ color: string }> = ({ color }) => {
  const anim = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.timing(anim, { toValue: 1, duration: 1100, easing: Easing.linear, useNativeDriver: true }),
    );
    loop.start();
    return () => loop.stop();
  }, [anim]);
  return (
    <View style={styles.typingRow}>
      {[0, 1, 2].map((index) => (
        <Animated.View
          key={index}
          style={[
            styles.typingDot,
            {
              backgroundColor: color,
              opacity: anim.interpolate({
                inputRange: [0, 0.2 + index * 0.2, 0.4 + index * 0.2, 1],
                outputRange: [0.25, 1, 0.25, 0.25],
                extrapolate: 'clamp',
              }),
            },
          ]}
        />
      ))}
    </View>
  );
};

/* ─── Home Screen ─────────────────────────── */
export const HomeScreen: React.FC = () => {
  const pipelineState = useAppStore((s) => s.pipelineState);
  const currentTranscription = useAppStore((s) => s.currentTranscription);
  const interimTranscription = useAppStore((s) => s.interimTranscription);
  const currentResponse = useAppStore((s) => s.currentResponse);
  const error = useAppStore((s) => s.error);
  const isBluetoothConnected = useAppStore((s) => s.isBluetoothConnected);
  const bluetoothDeviceName = useAppStore((s) => s.bluetoothDeviceName);
  const bluetoothBattery = useAppStore((s) => s.bluetoothBattery);
  const settings = useAppStore((s) => s.settings);
  const latencyMetrics = useAppStore((s) => s.latencyMetrics);
  const activeSession = useAppStore((s) => s.chatSessions.find((session) => session.id === s.activeSessionId));
  const clearError = useAppStore((s) => s.clearError);
  const setActiveSession = useAppStore((s) => s.setActiveSession);

  const insets = useSafeAreaInsets();
  const { scanForDevices, connectToDevice, disconnect, isScanning, isAutoConnecting, bleAvailable } = useBluetooth();
  const {
    startSession: startGrokSession,
    stopSession: stopGrokSession,
    isActive: isGrokActive,
  } = useGrokVoice();

  const isGrokMode = settings.voiceMode === 'grok';
  const handleGrokToggle = useCallback(() => {
    if (isGrokActive()) stopGrokSession();
    else startGrokSession();
  }, [isGrokActive, startGrokSession, stopGrokSession]);

  const {
    startListening,
    stopListeningAndProcess,
    sendTextMessage,
    cancelListening,
    forceStop,
    interruptAndListen,
  } = usePipeline({ onGrokButtonPress: handleGrokToggle });

  const [textInput, setTextInput] = useState('');
  const [showBLEModal, setShowBLEModal] = useState(false);
  const [foundDevices, setFoundDevices] = useState<BLEDevice[]>([]);
  const [connecting, setConnecting] = useState<string | null>(null);

  const entries: ConversationEntry[] = activeSession?.entries ?? [];
  const aiLabel = settings.wakeWord.trim().toUpperCase() || 'KAIRO';
  const modelName = (LLM_MODELS.find((model) => model.provider === settings.llmProvider && model.id === settings.llmModel)?.name
    || settings.llmModel).replace(/^Hermes \/\s*/, '');
  const voiceName = isGrokMode
    ? `Grok · ${settings.grokVoiceId}`
    : TTS_VOICES.find((voice) => voice.provider === settings.ttsProvider && voice.id === settings.ttsVoice)?.name || settings.ttsVoice;

  const isIdle = pipelineState === 'idle';
  const stateColor = STATE_COLOR[pipelineState];
  const hasInProgress = !!(interimTranscription || currentTranscription || currentResponse) || pipelineState === 'processing';
  const hasConversation = entries.length > 0 || hasInProgress;
  const grokLive = isGrokMode && isGrokActive();

  const stateCopy = useMemo(() => {
    if (isGrokMode) {
      if (grokLive) {
        return pipelineState === 'speaking'
          ? { title: 'Grok hablando', sub: 'Habla encima para interrumpir' }
          : { title: 'Grok en directo', sub: 'Habla con naturalidad · pulsa para terminar' };
      }
      return { title: 'Grok Realtime', sub: 'Pulsa el micrófono para abrir una sesión de voz' };
    }
    switch (pipelineState) {
      case 'listening': return { title: 'Escuchando', sub: 'Habla ahora · se enviará al detectar silencio' };
      case 'processing': return { title: 'Pensando', sub: `Consultando ${modelName}` };
      case 'speaking': return {
        title: 'Hablando',
        sub: settings.interruptSpeechWithWakeWord && Platform.OS !== 'web'
          ? `Di "${aiLabel}" o pulsa el micro para interrumpir`
          : 'Pulsa el micro para interrumpir',
      };
      default: return {
        title: 'En espera',
        sub: Platform.OS === 'web'
          ? 'Pulsa el micrófono o escribe un mensaje'
          : `Di "${aiLabel}", pulsa el botón de las gafas o el micrófono`,
      };
    }
  }, [aiLabel, grokLive, isGrokMode, modelName, pipelineState, settings.interruptSpeechWithWakeWord]);

  /* ── Actions ── */
  const handleMicPress = () => {
    clearError();
    if (isGrokMode) {
      if (isIdle || grokLive) handleGrokToggle();
      return;
    }
    if (pipelineState === 'listening') {
      stopListeningAndProcess();
    } else if (!isIdle) {
      if (settings.interruptSpeechWithButton) interruptAndListen();
      else forceStop();
    } else {
      Keyboard.dismiss();
      startListening();
    }
  };

  const handleStop = () => {
    if (isGrokMode) {
      stopGrokSession();
      return;
    }
    if (pipelineState === 'listening') cancelListening();
    else forceStop();
  };

  const handleSendText = (value?: string) => {
    const trimmed = (value ?? textInput).trim();
    if (!trimmed || !isIdle) return;
    clearError();
    Keyboard.dismiss();
    setTextInput('');
    sendTextMessage(trimmed);
  };

  const handleNewChat = () => {
    if (!isIdle) forceStop();
    setActiveSession(null);
  };

  const handleOpenBLEScan = async () => {
    setShowBLEModal(true);
    if (isBluetoothConnected) return;
    setFoundDevices([]);
    const devices = await scanForDevices();
    setFoundDevices(devices.filter((d) => d.name).map((d) => ({ id: d.id, name: d.name })));
  };

  const handleConnectDevice = async (deviceId: string) => {
    setConnecting(deviceId);
    const ok = await connectToDevice(deviceId);
    setConnecting(null);
    if (ok) setShowBLEModal(false);
    else Alert.alert('No se pudo conectar', 'Comprueba que las gafas están encendidas y cerca del iPhone.');
  };

  const handleDisconnect = () => {
    Alert.alert('Desconectar gafas', `¿Desconectar ${bluetoothDeviceName || 'las gafas'}?`, [
      { text: 'Cancelar', style: 'cancel' },
      {
        text: 'Desconectar',
        style: 'destructive',
        onPress: async () => {
          await disconnect();
          setShowBLEModal(false);
        },
      },
    ]);
  };

  /* ── Mic button appearance ── */
  const micConfig: { icon: IconName; color: string; label: string } = (() => {
    if (isGrokMode) {
      return grokLive
        ? { icon: 'phone-hangup', color: COLORS.error, label: 'Terminar sesión Grok' }
        : { icon: 'lightning-bolt', color: COLORS.accent, label: 'Iniciar sesión Grok' };
    }
    switch (pipelineState) {
      case 'listening': return { icon: 'send', color: COLORS.listening, label: 'Enviar ahora' };
      case 'processing': return { icon: 'stop', color: COLORS.processing, label: 'Detener' };
      case 'speaking': return settings.interruptSpeechWithButton
        ? { icon: 'microphone-message', color: COLORS.speaking, label: 'Interrumpir y hablar' }
        : { icon: 'stop', color: COLORS.speaking, label: 'Detener' };
      default: return { icon: 'microphone', color: COLORS.primary, label: 'Hablar' };
    }
  })();

  const batteryColor = bluetoothBattery != null && bluetoothBattery <= 20 ? COLORS.error : COLORS.success;
  const glassesLabel = isBluetoothConnected
    ? `${bluetoothDeviceName || 'Gafas'}${bluetoothBattery != null ? ` · ${bluetoothBattery}%` : ''}`
    : isAutoConnecting ? 'Buscando…' : 'Conectar gafas';
  const glassesColor = isBluetoothConnected ? batteryColor : isAutoConnecting ? COLORS.warning : COLORS.textSecondary;

  /* ── Conversation rendering (inverted list: newest at the bottom) ── */
  const renderEntry = useCallback(({ item }: { item: ConversationEntry }) => (
    <View>
      <Bubble role="user" label="TÚ" text={item.userMessage.content} time={item.userMessage.timestamp} />
      <Bubble role="assistant" label={aiLabel} text={item.assistantMessage.content} time={item.assistantMessage.timestamp} />
    </View>
  ), [aiLabel]);

  const inProgress = (
    <View>
      {(currentTranscription || interimTranscription) ? (
        <Bubble role="user" label="TÚ" text={currentTranscription || interimTranscription} pending={!currentTranscription} />
      ) : null}
      {currentResponse ? (
        <Bubble role="assistant" label={aiLabel} text={currentResponse} />
      ) : pipelineState === 'processing' ? (
        <View style={[styles.bubble, styles.bubbleAI]}>
          <Text style={[styles.bubbleLabel, { color: COLORS.primary }]}>{aiLabel}</Text>
          <TypingDots color={COLORS.primary} />
        </View>
      ) : null}
    </View>
  );

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        {/* ── Header ── */}
        <View style={styles.header}>
          <View style={styles.brand}>
            <View style={[styles.brandDot, { backgroundColor: stateColor, shadowColor: stateColor }]} />
            <View style={styles.flexShrink}>
              <Text style={styles.brandTitle}>{aiLabel}</Text>
              <Text style={[styles.brandState, { color: stateColor }]} numberOfLines={1}>
                {stateCopy.title}
              </Text>
            </View>
          </View>
          <View style={styles.headerActions}>
            <Pill
              label={glassesLabel}
              icon={isBluetoothConnected ? 'glasses' : isAutoConnecting ? 'radar' : 'bluetooth'}
              color={glassesColor}
              onPress={handleOpenBLEScan}
            />
            {hasConversation ? (
              <IconButton icon="square-edit-outline" label="Nueva conversación" onPress={handleNewChat} color={COLORS.text} filled />
            ) : null}
          </View>
        </View>

        {/* ── Body ── */}
        {hasConversation ? (
          <FlatList
            style={styles.flex}
            data={entries}
            keyExtractor={(item) => item.id}
            renderItem={renderEntry}
            inverted
            ListHeaderComponent={inProgress}
            contentContainerStyle={styles.conversationContent}
            keyboardDismissMode="interactive"
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
          />
        ) : (
          <ScrollView
            style={styles.flex}
            contentContainerStyle={styles.hero}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
          >
            <Pressable
              onPress={handleMicPress}
              accessibilityRole="button"
              accessibilityLabel={micConfig.label}
              style={({ pressed }) => pressed && { opacity: 0.8 }}
            >
              <ArcReactor state={pipelineState} />
            </Pressable>
            <Text style={[styles.heroTitle, { color: stateColor }]}>{stateCopy.title}</Text>
            <Text style={styles.heroSubtitle}>{stateCopy.sub}</Text>

            <View style={styles.infoRow}>
              <View style={styles.infoCell}>
                <Icon name="brain" size={16} color={COLORS.processing} />
                <Text style={styles.infoLabel}>MODELO</Text>
                <Text style={styles.infoValue} numberOfLines={2}>{isGrokMode ? 'Grok Realtime' : modelName}</Text>
              </View>
              <View style={styles.infoCell}>
                <Icon name="waveform" size={16} color={COLORS.speaking} />
                <Text style={styles.infoLabel}>VOZ</Text>
                <Text style={styles.infoValue} numberOfLines={2}>{voiceName}</Text>
              </View>
              <View style={styles.infoCell}>
                <Icon name="timer-outline" size={16} color={COLORS.primary} />
                <Text style={styles.infoLabel}>ÚLTIMA</Text>
                <Text style={styles.infoValue} numberOfLines={1}>{formatSeconds(latencyMetrics?.totalMs)}</Text>
              </View>
            </View>

            {!isGrokMode ? (
              <View style={styles.suggestions}>
                <Text style={styles.suggestionsTitle}>Prueba a preguntar</Text>
                {SUGGESTIONS.map((suggestion) => (
                  <Pressable
                    key={suggestion}
                    onPress={() => handleSendText(suggestion)}
                    disabled={!isIdle}
                    accessibilityRole="button"
                    style={({ pressed }) => [styles.suggestion, pressed && { opacity: 0.7 }, !isIdle && { opacity: 0.4 }]}
                  >
                    <Icon name="lightning-bolt-outline" size={15} color={COLORS.primary} />
                    <Text style={styles.suggestionText} numberOfLines={1}>{suggestion}</Text>
                  </Pressable>
                ))}
              </View>
            ) : null}
          </ScrollView>
        )}

        {/* ── Status strip (live transcript / errors) ── */}
        {error ? (
          <View style={styles.errorBar}>
            <Icon name="alert-circle" size={18} color={COLORS.error} />
            <Text style={styles.errorText} numberOfLines={3}>{error}</Text>
            <IconButton icon="close" label="Cerrar aviso" onPress={clearError} color={COLORS.error} size={18} />
          </View>
        ) : pipelineState === 'listening' && hasConversation ? (
          <View style={styles.liveBar}>
            <View style={styles.liveDot} />
            <Text style={styles.liveText} numberOfLines={2}>{interimTranscription || 'Escuchando…'}</Text>
          </View>
        ) : null}

        {/* ── Composer ── */}
        <View style={[styles.composer, { paddingBottom: Math.max(SPACING.sm, insets.bottom > 0 ? 6 : SPACING.sm) }]}>
          <View style={[styles.inputWrap, !isIdle && styles.inputWrapDisabled]}>
            <TextInput
              style={styles.textInput}
              value={textInput}
              onChangeText={setTextInput}
              placeholder={isIdle ? `Escribe a ${aiLabel}…` : stateCopy.title + '…'}
              placeholderTextColor={COLORS.textMuted}
              editable={isIdle && !grokLive}
              returnKeyType="send"
              onSubmitEditing={() => handleSendText()}
              submitBehavior="submit"
              multiline
              maxLength={2000}
              accessibilityLabel="Mensaje de texto"
            />
            {textInput.trim() ? (
              <IconButton
                icon="arrow-up"
                label="Enviar mensaje"
                onPress={() => handleSendText()}
                disabled={!isIdle}
                color={COLORS.onPrimary}
                style={styles.sendBtn}
              />
            ) : null}
          </View>

          {!isIdle && !isGrokMode ? (
            <IconButton
              icon="close"
              label={pipelineState === 'listening' ? 'Cancelar' : 'Parar'}
              onPress={handleStop}
              color={COLORS.textSecondary}
              filled
              style={styles.stopBtn}
            />
          ) : null}

          <Pressable
            onPress={handleMicPress}
            accessibilityRole="button"
            accessibilityLabel={micConfig.label}
            style={({ pressed }) => [
              styles.micBtn,
              { borderColor: micConfig.color, backgroundColor: withAlpha(micConfig.color, isIdle && !grokLive ? 0.14 : 0.24) },
              pressed && { transform: [{ scale: 0.94 }] },
            ]}
          >
            {pipelineState === 'processing' && !isGrokMode ? (
              <>
                <ActivityIndicator color={micConfig.color} style={StyleSheet.absoluteFill} />
                <Icon name="stop" size={14} color={micConfig.color} />
              </>
            ) : (
              <Icon name={micConfig.icon} size={26} color={micConfig.color} />
            )}
          </Pressable>
        </View>
      </KeyboardAvoidingView>

      {/* ── Glasses sheet ── */}
      <Modal visible={showBLEModal} transparent animationType="slide" onRequestClose={() => setShowBLEModal(false)}>
        <Pressable style={styles.modalOverlay} onPress={() => setShowBLEModal(false)}>
          <Pressable style={[styles.sheet, { paddingBottom: SPACING.lg + insets.bottom }]} onPress={() => {}}>
            <View style={styles.sheetHandle} />
            <View style={styles.sheetHeader}>
              <Text style={styles.sheetTitle}>Gafas</Text>
              <IconButton icon="close" label="Cerrar" onPress={() => setShowBLEModal(false)} color={COLORS.text} />
            </View>

            {isBluetoothConnected ? (
              <View style={styles.connectedCard}>
                <View style={styles.connectedIcon}>
                  <Icon name="glasses" size={28} color={COLORS.success} />
                </View>
                <View style={styles.flex}>
                  <Text style={styles.connectedName}>{bluetoothDeviceName || 'Gafas conectadas'}</Text>
                  <Text style={styles.connectedMeta}>
                    Conectadas{bluetoothBattery != null ? ` · batería ${bluetoothBattery}%` : ''}
                  </Text>
                </View>
                <Button label="Desconectar" variant="danger" compact onPress={handleDisconnect} />
              </View>
            ) : (
              <>
                {!bleAvailable ? (
                  <View style={styles.bleWarning}>
                    <Icon name="bluetooth-off" size={20} color={COLORS.warning} />
                    <Text style={styles.bleWarningText}>
                      Bluetooth no disponible. Actívalo en el Centro de control o en Ajustes del iPhone.
                    </Text>
                  </View>
                ) : null}

                {isScanning ? (
                  <View style={styles.scanningRow}>
                    <ActivityIndicator color={COLORS.primary} />
                    <Text style={styles.scanningText}>Buscando gafas cercanas…</Text>
                  </View>
                ) : null}

                {!isScanning && foundDevices.length === 0 && bleAvailable ? (
                  <Text style={styles.noDevicesText}>
                    No se encontraron gafas. Asegúrate de que están encendidas y cerca.
                  </Text>
                ) : null}

                {foundDevices.map((item) => (
                  <Pressable
                    key={item.id}
                    style={({ pressed }) => [styles.deviceRow, pressed && { opacity: 0.7 }]}
                    onPress={() => handleConnectDevice(item.id)}
                    disabled={connecting !== null}
                    accessibilityRole="button"
                    accessibilityLabel={`Conectar ${item.name || 'dispositivo'}`}
                  >
                    <View style={styles.deviceIcon}>
                      <Icon name="glasses" size={20} color={COLORS.primary} />
                    </View>
                    <View style={styles.flex}>
                      <Text style={styles.deviceNameText}>{item.name || 'Dispositivo'}</Text>
                      <Text style={styles.deviceIdText} numberOfLines={1}>{item.id}</Text>
                    </View>
                    {connecting === item.id ? (
                      <ActivityIndicator size="small" color={COLORS.primary} />
                    ) : (
                      <Text style={styles.deviceConnect}>Conectar</Text>
                    )}
                  </Pressable>
                ))}

                {bleAvailable && !isScanning ? (
                  <Button label="Volver a buscar" icon="refresh" variant="ghost" onPress={handleOpenBLEScan} style={styles.rescanBtn} />
                ) : null}
              </>
            )}
          </Pressable>
        </Pressable>
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
  flex: { flex: 1 },
  flexShrink: { flexShrink: 1 },
  /* Header */
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    paddingHorizontal: SPACING.md,
    paddingTop: SPACING.sm,
    paddingBottom: 10,
  },
  brand: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    flexShrink: 1,
  },
  brandDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    shadowOpacity: 0.9,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 0 },
  },
  brandTitle: {
    fontSize: 22,
    fontWeight: '900',
    color: COLORS.text,
    letterSpacing: 2,
  },
  brandState: {
    fontSize: 12,
    fontWeight: '700',
    marginTop: -1,
  },
  headerActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    flexShrink: 1,
  },
  /* Hero */
  hero: {
    flexGrow: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: SPACING.lg,
    paddingVertical: SPACING.lg,
  },
  heroTitle: {
    fontSize: 22,
    fontWeight: '800',
    letterSpacing: 0.5,
    marginTop: SPACING.lg,
  },
  heroSubtitle: {
    fontSize: 14,
    color: COLORS.textSecondary,
    textAlign: 'center',
    lineHeight: 20,
    marginTop: 6,
    maxWidth: 320,
  },
  infoRow: {
    flexDirection: 'row',
    gap: 8,
    marginTop: SPACING.lg,
    alignSelf: 'stretch',
  },
  infoCell: {
    flex: 1,
    backgroundColor: COLORS.card,
    borderRadius: RADIUS.md,
    borderWidth: 1,
    borderColor: COLORS.border,
    padding: 10,
    gap: 3,
  },
  infoLabel: {
    fontSize: 9,
    fontWeight: '800',
    color: COLORS.textMuted,
    letterSpacing: 1,
    marginTop: 4,
  },
  infoValue: {
    fontSize: 13,
    fontWeight: '700',
    color: COLORS.text,
  },
  suggestions: {
    alignSelf: 'stretch',
    marginTop: SPACING.lg,
    gap: 8,
  },
  suggestionsTitle: {
    fontSize: 11,
    fontWeight: '800',
    color: COLORS.textMuted,
    letterSpacing: 1.1,
    textTransform: 'uppercase',
    marginBottom: 2,
  },
  suggestion: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderRadius: RADIUS.md,
    backgroundColor: COLORS.card,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  suggestionText: {
    flex: 1,
    fontSize: 14,
    color: COLORS.text,
  },
  /* Conversation */
  conversationContent: {
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.sm,
    flexGrow: 1,
  },
  bubble: {
    maxWidth: '86%',
    borderRadius: 18,
    paddingHorizontal: 14,
    paddingVertical: 10,
    marginVertical: 5,
    borderWidth: 1,
  },
  bubbleUser: {
    alignSelf: 'flex-end',
    backgroundColor: withAlpha(COLORS.primary, 0.13),
    borderColor: withAlpha(COLORS.primary, 0.3),
    borderBottomRightRadius: 6,
  },
  bubbleAI: {
    alignSelf: 'flex-start',
    backgroundColor: COLORS.surface,
    borderColor: COLORS.border,
    borderBottomLeftRadius: 6,
  },
  bubbleMeta: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 3,
  },
  bubbleLabel: {
    fontSize: 10,
    fontWeight: '900',
    letterSpacing: 0.8,
  },
  bubbleTime: {
    fontSize: 10,
    color: COLORS.textMuted,
  },
  bubbleText: {
    fontSize: 15,
    color: COLORS.text,
    lineHeight: 22,
  },
  bubbleTextPending: {
    color: COLORS.textSecondary,
    fontStyle: 'italic',
  },
  typingRow: {
    flexDirection: 'row',
    gap: 5,
    paddingVertical: 6,
  },
  typingDot: {
    width: 7,
    height: 7,
    borderRadius: 4,
  },
  /* Status strip */
  errorBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginHorizontal: SPACING.md,
    marginBottom: 6,
    paddingLeft: 12,
    paddingVertical: 4,
    borderRadius: RADIUS.md,
    backgroundColor: withAlpha(COLORS.error, 0.1),
    borderWidth: 1,
    borderColor: withAlpha(COLORS.error, 0.35),
  },
  errorText: {
    flex: 1,
    color: COLORS.error,
    fontSize: 13,
    lineHeight: 18,
    paddingVertical: 6,
  },
  liveBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginHorizontal: SPACING.md,
    marginBottom: 6,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: RADIUS.md,
    backgroundColor: withAlpha(COLORS.listening, 0.08),
    borderWidth: 1,
    borderColor: withAlpha(COLORS.listening, 0.3),
  },
  liveDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: COLORS.listening,
  },
  liveText: {
    flex: 1,
    fontSize: 13,
    color: COLORS.text,
    fontStyle: 'italic',
  },
  /* Composer */
  composer: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 8,
    paddingHorizontal: SPACING.md,
    paddingTop: 6,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: COLORS.border,
    backgroundColor: COLORS.background,
  },
  inputWrap: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'flex-end',
    minHeight: 52,
    backgroundColor: COLORS.surface,
    borderRadius: 26,
    borderWidth: 1,
    borderColor: COLORS.border,
    paddingLeft: 16,
    paddingRight: 6,
    paddingVertical: 6,
  },
  inputWrapDisabled: {
    opacity: 0.6,
  },
  textInput: {
    flex: 1,
    color: COLORS.text,
    fontSize: 15,
    maxHeight: 120,
    paddingTop: Platform.OS === 'ios' ? 10 : 6,
    paddingBottom: Platform.OS === 'ios' ? 10 : 6,
  },
  sendBtn: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: COLORS.primary,
  },
  stopBtn: {
    width: 52,
    height: 52,
    borderRadius: 26,
  },
  micBtn: {
    width: 52,
    height: 52,
    borderRadius: 26,
    borderWidth: 1.5,
    alignItems: 'center',
    justifyContent: 'center',
  },
  /* Glasses sheet */
  modalOverlay: {
    flex: 1,
    backgroundColor: COLORS.overlay,
    justifyContent: 'flex-end',
  },
  sheet: {
    backgroundColor: COLORS.card,
    borderTopLeftRadius: RADIUS.xl,
    borderTopRightRadius: RADIUS.xl,
    paddingHorizontal: SPACING.md,
    paddingTop: 8,
    maxHeight: '75%',
    borderTopWidth: 1,
    borderColor: COLORS.border,
  },
  sheetHandle: {
    alignSelf: 'center',
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: COLORS.borderLight,
    marginBottom: 8,
  },
  sheetHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: SPACING.sm,
  },
  sheetTitle: {
    fontSize: 20,
    fontWeight: '800',
    color: COLORS.text,
  },
  connectedCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    padding: 14,
    borderRadius: RADIUS.lg,
    backgroundColor: withAlpha(COLORS.success, 0.07),
    borderWidth: 1,
    borderColor: withAlpha(COLORS.success, 0.3),
  },
  connectedIcon: {
    width: 48,
    height: 48,
    borderRadius: 24,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: withAlpha(COLORS.success, 0.12),
  },
  connectedName: {
    fontSize: 16,
    fontWeight: '700',
    color: COLORS.text,
  },
  connectedMeta: {
    fontSize: 12,
    color: COLORS.textSecondary,
    marginTop: 2,
  },
  bleWarning: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
    backgroundColor: withAlpha(COLORS.warning, 0.1),
    padding: 12,
    borderRadius: RADIUS.md,
    marginBottom: 12,
  },
  bleWarningText: {
    flex: 1,
    fontSize: 13,
    color: COLORS.warning,
    lineHeight: 18,
  },
  scanningRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 14,
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
    lineHeight: 20,
  },
  deviceRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: COLORS.border,
  },
  deviceIcon: {
    width: 38,
    height: 38,
    borderRadius: 19,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: withAlpha(COLORS.primary, 0.1),
  },
  deviceNameText: {
    fontSize: 15,
    fontWeight: '600',
    color: COLORS.text,
  },
  deviceIdText: {
    fontSize: 11,
    color: COLORS.textMuted,
    marginTop: 2,
  },
  deviceConnect: {
    fontSize: 13,
    fontWeight: '700',
    color: COLORS.primary,
  },
  rescanBtn: {
    marginTop: SPACING.sm,
  },
});
