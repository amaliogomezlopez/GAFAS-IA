import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
  Platform,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { MaterialCommunityIcons as Icon } from '@expo/vector-icons';
import { COLORS } from '../../constants';
import { useAppStore } from '../../stores';
import { AudioService } from '../../services/audio';
import { BluetoothService, type GlassesButtonEvent, type GlassesButtonKind } from '../../services/bluetooth';
import { LogService, type LogEntry, type LogLevel } from '../../services/LogService';
import { STTService, TTSService } from '../../services/ai';

type DebugDevice = {
  id: string;
  name: string | null;
};

type TestState = 'idle' | 'running' | 'ok' | 'error';
type ButtonCaptureMode = 'idle' | 'photo' | 'video';

const LOG_COLORS: Record<LogLevel, string> = {
  debug: COLORS.textMuted,
  info: COLORS.primary,
  warn: COLORS.warning,
  error: COLORS.error,
};

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const formatTime = (timestamp: number) => (
  new Date(timestamp).toLocaleTimeString('es-ES', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
);

const captureLabel: Record<ButtonCaptureMode, string> = {
  idle: 'Sin captura',
  photo: 'Capturando foto',
  video: 'Capturando video',
};

function summarizeSignatures(events: GlassesButtonEvent[]): Array<{ signature: string; count: number }> {
  const counts = new Map<string, number>();
  events.forEach((event) => {
    counts.set(event.signature, (counts.get(event.signature) ?? 0) + 1);
  });
  return Array.from(counts.entries())
    .map(([signature, count]) => ({ signature, count }))
    .sort((a, b) => b.count - a.count || a.signature.localeCompare(b.signature));
}

function findDistinctSignature(primary: GlassesButtonEvent[], other: GlassesButtonEvent[]): string {
  const otherSignatures = new Set(other.map((event) => event.signature));
  return summarizeSignatures(primary).find((item) => !otherSignatures.has(item.signature))?.signature || 'Pendiente';
}

const StatusPill: React.FC<{
  label: string;
  value: string;
  tone?: 'ok' | 'warn' | 'error' | 'neutral';
}> = ({ label, value, tone = 'neutral' }) => {
  const color =
    tone === 'ok' ? COLORS.success :
    tone === 'warn' ? COLORS.warning :
    tone === 'error' ? COLORS.error :
    COLORS.textSecondary;

  return (
    <View style={styles.statusPill}>
      <Text style={styles.statusLabel}>{label}</Text>
      <Text style={[styles.statusValue, { color }]} numberOfLines={1}>{value}</Text>
    </View>
  );
};

const DebugButton: React.FC<{
  icon: string;
  label: string;
  onPress: () => void;
  disabled?: boolean;
  tone?: 'primary' | 'success' | 'warning' | 'danger';
}> = ({ icon, label, onPress, disabled, tone = 'primary' }) => {
  const color =
    tone === 'success' ? COLORS.success :
    tone === 'warning' ? COLORS.warning :
    tone === 'danger' ? COLORS.error :
    COLORS.primary;

  return (
    <TouchableOpacity
      style={[styles.debugButton, { borderColor: `${color}55` }, disabled && styles.debugButtonDisabled]}
      onPress={onPress}
      disabled={disabled}
      activeOpacity={0.72}
    >
      <Icon name={icon as any} size={19} color={disabled ? COLORS.textMuted : color} />
      <Text style={[styles.debugButtonText, { color: disabled ? COLORS.textMuted : COLORS.text }]}>
        {label}
      </Text>
    </TouchableOpacity>
  );
};

const ButtonEventRow: React.FC<{ event: GlassesButtonEvent; sampleKind?: GlassesButtonKind }> = ({ event, sampleKind }) => (
  <View style={styles.buttonEventRow}>
    <View style={styles.buttonEventTop}>
      <Text style={styles.buttonEventTime}>{formatTime(event.timestamp)}</Text>
      <Text style={styles.buttonEventKind}>
        {(sampleKind || event.kind).toUpperCase()} · {event.source.toUpperCase()}
      </Text>
    </View>
    <Text style={styles.buttonEventSignature} numberOfLines={2}>{event.signature}</Text>
    <Text style={styles.buttonEventBytes} numberOfLines={1}>
      bytes [{event.decimal || 'manual'}] · ascii "{event.ascii || '-'}"
    </Text>
  </View>
);

export const DebugScreen: React.FC = () => {
  const {
    settings,
    pipelineState,
    currentTranscription,
    interimTranscription,
    currentResponse,
    latencyMetrics,
    isBluetoothConnected,
    bluetoothDeviceName,
    bluetoothBattery,
    setBluetoothStatus,
  } = useAppStore();

  const [logs, setLogs] = useState<LogEntry[]>(() => LogService.getLogs());
  const [devices, setDevices] = useState<DebugDevice[]>([]);
  const [bleAvailable, setBleAvailable] = useState(() => BluetoothService.getBluetoothStatus().bleAvailable);
  const [isScanning, setIsScanning] = useState(false);
  const [connectingId, setConnectingId] = useState<string | null>(null);
  const [audioState, setAudioState] = useState<TestState>('idle');
  const [ttsState, setTtsState] = useState<TestState>('idle');
  const [sttState, setSttState] = useState<TestState>('idle');
  const [smokeState, setSmokeState] = useState<TestState>('idle');
  const [lastRecording, setLastRecording] = useState<{ uri: string; duration: number } | null>(null);
  const [sttTranscript, setSttTranscript] = useState('');
  const [buttonEvents, setButtonEvents] = useState<GlassesButtonEvent[]>(() => BluetoothService.getButtonEventHistory());
  const [photoButtonEvents, setPhotoButtonEvents] = useState<GlassesButtonEvent[]>([]);
  const [videoButtonEvents, setVideoButtonEvents] = useState<GlassesButtonEvent[]>([]);
  const [buttonCaptureMode, setButtonCaptureMode] = useState<ButtonCaptureMode>('idle');
  const [lastButtonEvent, setLastButtonEvent] = useState<GlassesButtonEvent | null>(null);
  const scanIdRef = useRef(0);
  const buttonCaptureModeRef = useRef<ButtonCaptureMode>('idle');
  buttonCaptureModeRef.current = buttonCaptureMode;

  useEffect(() => {
    const syncBluetoothStatus = () => {
      const status = BluetoothService.getBluetoothStatus();
      setBleAvailable(status.bleAvailable);
      setBluetoothStatus(status.isConnected, status.deviceName, status.battery);
    };

    BluetoothService.initialize().then(syncBluetoothStatus).catch((error) => {
      LogService.warn('Debug', `BLE init failed: ${error}`);
      syncBluetoothStatus();
    });

    const unsubBle = BluetoothService.onStatusChange((connected, deviceName, battery) => {
      setBluetoothStatus(connected, deviceName, battery);
      setBleAvailable(BluetoothService.getBluetoothStatus().bleAvailable);
    });
    const unsubLogs = LogService.subscribe(() => setLogs([...LogService.getLogs()]));
    const unsubButtonEvents = BluetoothService.subscribeButtonEvents((event) => {
      setButtonEvents(BluetoothService.getButtonEventHistory());
      setLastButtonEvent(event);
      const mode = buttonCaptureModeRef.current;
      if (mode === 'photo') {
        const taggedEvent: GlassesButtonEvent = { ...event, kind: 'photo' };
        setPhotoButtonEvents((items) => [taggedEvent, ...items].slice(0, 24));
      } else if (mode === 'video') {
        const taggedEvent: GlassesButtonEvent = { ...event, kind: 'video' };
        setVideoButtonEvents((items) => [taggedEvent, ...items].slice(0, 24));
      }
    });

    return () => {
      unsubBle();
      unsubLogs();
      unsubButtonEvents();
    };
  }, [setBluetoothStatus]);

  const latestLogs = useMemo(() => logs.slice(0, 80), [logs]);
  const latestButtonEvents = useMemo(() => buttonEvents.slice(0, 10), [buttonEvents]);
  const photoSignatureCandidate = useMemo(
    () => findDistinctSignature(photoButtonEvents, videoButtonEvents),
    [photoButtonEvents, videoButtonEvents],
  );
  const videoSignatureCandidate = useMemo(
    () => findDistinctSignature(videoButtonEvents, photoButtonEvents),
    [photoButtonEvents, videoButtonEvents],
  );

  const addDebugLog = useCallback((message: string, level: LogLevel = 'info') => {
    LogService.log(level, 'Debug', message);
  }, []);

  const handleScan = useCallback(async () => {
    const currentScanId = scanIdRef.current + 1;
    scanIdRef.current = currentScanId;
    setIsScanning(true);
    setDevices([]);
    addDebugLog('BLE scan started');

    try {
      const foundDevices = await BluetoothService.startScan();
      if (scanIdRef.current !== currentScanId) return;
      const mapped = foundDevices.map((device: any) => ({
        id: device.id,
        name: device.name ?? null,
      }));
      setDevices(mapped);
      addDebugLog(`BLE scan finished: ${mapped.length} devices`);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      addDebugLog(`BLE scan failed: ${msg}`, 'error');
      Alert.alert('BLE scan error', msg);
    } finally {
      if (scanIdRef.current === currentScanId) setIsScanning(false);
    }
  }, [addDebugLog]);

  const handleStopScan = useCallback(() => {
    scanIdRef.current += 1;
    BluetoothService.stopScan();
    setIsScanning(false);
    addDebugLog('BLE scan stopped manually');
  }, [addDebugLog]);

  const handleConnect = useCallback(async (deviceId: string) => {
    setConnectingId(deviceId);
    addDebugLog(`Connecting to ${deviceId}`);
    try {
      const connected = await BluetoothService.connectToDevice(deviceId);
      const status = BluetoothService.getBluetoothStatus();
      setBluetoothStatus(status.isConnected, status.deviceName, status.battery);
      setBleAvailable(status.bleAvailable);
      addDebugLog(connected ? `Connected to ${status.deviceName || deviceId}` : `Connection failed: ${deviceId}`, connected ? 'info' : 'warn');
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      addDebugLog(`Connect error: ${msg}`, 'error');
      Alert.alert('BLE connect error', msg);
    } finally {
      setConnectingId(null);
    }
  }, [addDebugLog, setBluetoothStatus]);

  const handleDisconnect = useCallback(async () => {
    await BluetoothService.disconnect();
    const status = BluetoothService.getBluetoothStatus();
    setBluetoothStatus(status.isConnected, status.deviceName, status.battery);
    addDebugLog('BLE disconnected manually', 'warn');
  }, [addDebugLog, setBluetoothStatus]);

  const handleSimulateButton = useCallback(() => {
    BluetoothService.notifyButtonPress();
    addDebugLog('Simulated BLE button press');
  }, [addDebugLog]);

  const handleStartButtonCapture = useCallback((mode: Exclude<ButtonCaptureMode, 'idle'>) => {
    setButtonCaptureMode(mode);
    if (mode === 'photo') {
      setPhotoButtonEvents([]);
    } else {
      setVideoButtonEvents([]);
    }
    addDebugLog(`Camera button capture started: ${mode}`);
  }, [addDebugLog]);

  const handleStopButtonCapture = useCallback(() => {
    setButtonCaptureMode('idle');
    addDebugLog('Camera button capture stopped');
  }, [addDebugLog]);

  const handleClearButtonSamples = useCallback(() => {
    BluetoothService.clearButtonEventHistory();
    setButtonEvents([]);
    setPhotoButtonEvents([]);
    setVideoButtonEvents([]);
    setLastButtonEvent(null);
    setButtonCaptureMode('idle');
    addDebugLog('Camera button samples cleared', 'warn');
  }, [addDebugLog]);

  const handleExportButtonSamples = useCallback(async () => {
    const report = {
      createdAt: new Date().toISOString(),
      device: BluetoothService.getBluetoothStatus(),
      capture: {
        photoCount: photoButtonEvents.length,
        videoCount: videoButtonEvents.length,
        photoSignatureCandidate,
        videoSignatureCandidate,
      },
      photoSignatures: summarizeSignatures(photoButtonEvents),
      videoSignatures: summarizeSignatures(videoButtonEvents),
      photoEvents: photoButtonEvents,
      videoEvents: videoButtonEvents,
      recentEvents: buttonEvents.slice(0, 40),
    };
    try {
      await Share.share({
        title: 'SmartGlasses Camera Button BLE Report',
        message: JSON.stringify(report, null, 2),
      });
    } catch {}
  }, [buttonEvents, photoButtonEvents, photoSignatureCandidate, videoButtonEvents, videoSignatureCandidate]);

  const handleRecordMic = useCallback(async () => {
    setAudioState('running');
    setLastRecording(null);
    addDebugLog('Mic test: recording 3 seconds');
    try {
      await AudioService.startRecording();
      await wait(3000);
      const result = await AudioService.stopRecording();
      setLastRecording(result);
      setAudioState(result.uri ? 'ok' : 'error');
      addDebugLog(`Mic test complete: ${result.duration}ms, uri=${result.uri || 'empty'}`, result.uri ? 'info' : 'warn');
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      setAudioState('error');
      addDebugLog(`Mic test failed: ${msg}`, 'error');
      Alert.alert('Audio input error', msg);
      try { await AudioService.stopRecording(); } catch {}
    }
  }, [addDebugLog]);

  const handlePlayRecording = useCallback(async () => {
    if (!lastRecording?.uri) return;
    setAudioState('running');
    addDebugLog('Playing last mic recording');
    try {
      await AudioService.playAudio(lastRecording.uri);
      setAudioState('ok');
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      setAudioState('error');
      addDebugLog(`Recording playback failed: ${msg}`, 'error');
      Alert.alert('Playback error', msg);
    }
  }, [addDebugLog, lastRecording]);

  const handleTtsTest = useCallback(async () => {
    setTtsState('running');
    addDebugLog(`TTS test started (${settings.ttsProvider}/${settings.ttsVoice})`);
    try {
      await TTSService.synthesize(
        'Prueba de salida de audio completada.',
        settings.ttsProvider,
        settings.ttsVoice,
        {
          language: settings.ttsLanguage,
          nativeVoiceId: settings.ttsNativeVoiceId || undefined,
          rate: settings.ttsRate,
          pitch: settings.ttsPitch,
        },
      );
      setTtsState('ok');
      addDebugLog('TTS test complete');
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      setTtsState('error');
      addDebugLog(`TTS test failed: ${msg}`, 'error');
      Alert.alert('TTS error', msg);
    }
  }, [
    addDebugLog,
    settings.ttsLanguage,
    settings.ttsNativeVoiceId,
    settings.ttsPitch,
    settings.ttsProvider,
    settings.ttsRate,
    settings.ttsVoice,
  ]);

  const handleSttTest = useCallback(async () => {
    setSttState('running');
    setSttTranscript('');
    addDebugLog('STT test started');
    try {
      await STTService.startListening({
        language: settings.wakeWordLang,
        silenceTimeoutMs: 5000,
        finalSilenceTimeoutMs: 900,
        stopTimeoutMs: settings.sttStopTimeoutMs,
        maxListeningDurationMs: 7000,
        onInterim: setSttTranscript,
      });
      await wait(4200);
      const transcript = await STTService.stopAndGetTranscript();
      setSttTranscript(transcript);
      setSttState(transcript.trim() ? 'ok' : 'error');
      addDebugLog(`STT test transcript: "${transcript || '(empty)'}"`, transcript.trim() ? 'info' : 'warn');
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      setSttState('error');
      addDebugLog(`STT test failed: ${msg}`, 'error');
      Alert.alert('STT error', msg);
      STTService.cancel();
    }
  }, [addDebugLog, settings.sttStopTimeoutMs, settings.wakeWordLang]);

  const handleSmokeTest = useCallback(async () => {
    setSmokeState('running');
    addDebugLog('Smoke test started');
    try {
      const status = BluetoothService.getBluetoothStatus();
      addDebugLog(`BLE status: available=${status.bleAvailable}, connected=${status.isConnected}, device=${status.deviceName || 'none'}`);
      BluetoothService.notifyButtonPress();
      await AudioService.prepareForPlayback();
      await TTSService.synthesize('Test rapido de diagnostico.', 'native', 'native-ios', { language: 'es-ES', rate: 1.1 });
      setSmokeState('ok');
      addDebugLog('Smoke test complete');
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      setSmokeState('error');
      addDebugLog(`Smoke test failed: ${msg}`, 'error');
      Alert.alert('Smoke test error', msg);
    }
  }, [addDebugLog]);

  const handleExportLogs = useCallback(async () => {
    try {
      await Share.share({ title: 'SmartGlasses Debug Logs', message: LogService.exportAsText() });
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

  const bluetoothTone = isBluetoothConnected ? 'ok' : bleAvailable ? 'warn' : 'error';
  const pipelineSummary = currentTranscription || interimTranscription || currentResponse || 'Sin turno activo';

  return (
    <SafeAreaView style={styles.container}>
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.header}>
          <View style={styles.headerIcon}>
            <Icon name="bug-check-outline" size={26} color={COLORS.primary} />
          </View>
          <View style={styles.headerText}>
            <Text style={styles.title}>Diagnóstico</Text>
            <Text style={styles.subtitle} numberOfLines={2}>
              BLE, audio, STT/TTS y logs técnicos en un solo panel.
            </Text>
          </View>
        </View>

        <View style={styles.statusGrid}>
          <StatusPill
            label="BLE"
            value={isBluetoothConnected ? bluetoothDeviceName || 'Conectado' : bleAvailable ? 'Disponible' : 'No disponible'}
            tone={bluetoothTone}
          />
          <StatusPill
            label="Batería"
            value={bluetoothBattery != null ? `${bluetoothBattery}%` : 'N/A'}
            tone={bluetoothBattery == null ? 'neutral' : bluetoothBattery > 20 ? 'ok' : 'warn'}
          />
          <StatusPill label="Pipeline" value={pipelineState.toUpperCase()} tone={pipelineState === 'idle' ? 'neutral' : 'ok'} />
          <StatusPill
            label="Latencia"
            value={latencyMetrics?.totalMs ? `${latencyMetrics.totalMs}ms` : 'N/A'}
            tone={latencyMetrics?.totalMs ? 'ok' : 'neutral'}
          />
        </View>

        <View style={styles.panel}>
          <View style={styles.panelHeader}>
            <Icon name="bluetooth-connect" size={20} color={COLORS.primary} />
            <Text style={styles.panelTitle}>Bluetooth</Text>
            {isScanning ? <ActivityIndicator color={COLORS.primary} size="small" /> : null}
          </View>
          <View style={styles.buttonGrid}>
            <DebugButton icon="radar" label={isScanning ? 'Escaneando' : 'Buscar BLE'} onPress={handleScan} disabled={isScanning} />
            <DebugButton icon="stop-circle-outline" label="Parar scan" onPress={handleStopScan} disabled={!isScanning} tone="warning" />
            <DebugButton icon="gesture-tap-button" label="Botón simulado" onPress={handleSimulateButton} tone="success" />
            <DebugButton icon="bluetooth-off" label="Desconectar" onPress={handleDisconnect} disabled={!isBluetoothConnected} tone="danger" />
          </View>

          {devices.length > 0 ? (
            <View style={styles.deviceList}>
              {devices.map((device) => (
                <TouchableOpacity
                  key={device.id}
                  style={styles.deviceRow}
                  onPress={() => handleConnect(device.id)}
                  disabled={connectingId !== null}
                  activeOpacity={0.72}
                >
                  <Icon name="bluetooth" size={18} color={COLORS.primary} />
                  <View style={styles.deviceInfo}>
                    <Text style={styles.deviceName}>{device.name || 'Unknown device'}</Text>
                    <Text style={styles.deviceId} numberOfLines={1}>{device.id}</Text>
                  </View>
                  {connectingId === device.id ? (
                    <ActivityIndicator color={COLORS.primary} size="small" />
                  ) : (
                    <Icon name="link-variant" size={18} color={COLORS.textSecondary} />
                  )}
                </TouchableOpacity>
              ))}
            </View>
          ) : (
            <Text style={styles.hint}>Sin dispositivos listados todavía.</Text>
          )}
        </View>

        <View style={styles.panel}>
          <View style={styles.panelHeader}>
            <Icon name="camera-iris" size={20} color={COLORS.accent} />
            <Text style={styles.panelTitle}>Laboratorio botones cámara</Text>
          </View>
          <Text style={styles.hint}>
            Pulsa "Capturar foto" y toca el botón físico de foto varias veces. Luego haz lo mismo con vídeo. La app guardará UUID, bytes y firma para distinguirlos.
          </Text>

          <View style={styles.buttonGrid}>
            <DebugButton
              icon="camera"
              label={buttonCaptureMode === 'photo' ? 'Capturando foto' : 'Capturar foto'}
              onPress={() => handleStartButtonCapture('photo')}
              disabled={!isBluetoothConnected || buttonCaptureMode === 'photo'}
              tone="success"
            />
            <DebugButton
              icon="video"
              label={buttonCaptureMode === 'video' ? 'Capturando video' : 'Capturar video'}
              onPress={() => handleStartButtonCapture('video')}
              disabled={!isBluetoothConnected || buttonCaptureMode === 'video'}
              tone="warning"
            />
            <DebugButton
              icon="stop-circle-outline"
              label="Parar captura"
              onPress={handleStopButtonCapture}
              disabled={buttonCaptureMode === 'idle'}
              tone="danger"
            />
            <DebugButton
              icon="share-variant"
              label="Exportar botones"
              onPress={handleExportButtonSamples}
              disabled={photoButtonEvents.length + videoButtonEvents.length === 0}
            />
            <DebugButton
              icon="delete-outline"
              label="Limpiar muestras"
              onPress={handleClearButtonSamples}
              disabled={buttonEvents.length + photoButtonEvents.length + videoButtonEvents.length === 0}
              tone="danger"
            />
          </View>

          <View style={[styles.statusGrid, { marginTop: 12, marginBottom: 0 }]}>
            <StatusPill
              label="Modo"
              value={captureLabel[buttonCaptureMode]}
              tone={buttonCaptureMode === 'idle' ? 'neutral' : 'ok'}
            />
            <StatusPill label="Foto" value={`${photoButtonEvents.length} eventos`} tone={photoButtonEvents.length ? 'ok' : 'neutral'} />
            <StatusPill label="Video" value={`${videoButtonEvents.length} eventos`} tone={videoButtonEvents.length ? 'ok' : 'neutral'} />
            <StatusPill label="Recientes" value={`${buttonEvents.length}`} tone={buttonEvents.length ? 'ok' : 'neutral'} />
          </View>

          <View style={styles.signaturePanel}>
            <Text style={styles.signatureTitle}>Candidatos</Text>
            <Text style={styles.signatureText} numberOfLines={2}>Foto: {photoSignatureCandidate}</Text>
            <Text style={styles.signatureText} numberOfLines={2}>Video: {videoSignatureCandidate}</Text>
          </View>

          {lastButtonEvent ? (
            <>
              <Text style={styles.subPanelTitle}>Último evento BLE</Text>
              <ButtonEventRow event={lastButtonEvent} />
            </>
          ) : (
            <Text style={styles.hint}>Aún no hay eventos de botones de cámara. Conecta las gafas y pulsa uno de los botones superiores.</Text>
          )}

          {latestButtonEvents.length > 0 ? (
            <>
              <Text style={styles.subPanelTitle}>Eventos recientes</Text>
              {latestButtonEvents.map((event) => (
                <ButtonEventRow key={event.id} event={event} />
              ))}
            </>
          ) : null}
        </View>

        <View style={styles.panel}>
          <View style={styles.panelHeader}>
            <Icon name="microphone-outline" size={20} color={COLORS.listening} />
            <Text style={styles.panelTitle}>Audio y voz</Text>
          </View>
          <View style={styles.buttonGrid}>
            <DebugButton icon="record-rec" label={audioState === 'running' ? 'Grabando' : 'Grabar mic'} onPress={handleRecordMic} disabled={audioState === 'running'} />
            <DebugButton icon="play-circle-outline" label="Reproducir grabación" onPress={handlePlayRecording} disabled={!lastRecording?.uri || audioState === 'running'} tone="success" />
            <DebugButton icon="volume-high" label={ttsState === 'running' ? 'TTS...' : 'Probar TTS'} onPress={handleTtsTest} disabled={ttsState === 'running'} />
            <DebugButton icon="text-recognition" label={sttState === 'running' ? 'STT...' : 'Probar STT'} onPress={handleSttTest} disabled={sttState === 'running'} tone="warning" />
          </View>
          <Text style={styles.resultText}>
            Mic: {audioState} · TTS: {ttsState} · STT: {sttState}
          </Text>
          {lastRecording ? (
            <Text style={styles.hint} numberOfLines={2}>
              Grabación: {lastRecording.duration}ms · {lastRecording.uri || 'sin URI'}
            </Text>
          ) : null}
          {sttTranscript ? (
            <Text style={styles.transcript} numberOfLines={3}>{sttTranscript}</Text>
          ) : null}
        </View>

        <View style={styles.panel}>
          <View style={styles.panelHeader}>
            <Icon name="flask-outline" size={20} color={COLORS.accent} />
            <Text style={styles.panelTitle}>Smoke test</Text>
          </View>
          <DebugButton
            icon="play-speed"
            label={smokeState === 'running' ? 'Ejecutando...' : 'Ejecutar test rápido'}
            onPress={handleSmokeTest}
            disabled={smokeState === 'running'}
            tone="success"
          />
          <Text style={styles.hint}>
            Último estado: {smokeState}. Usa TTS nativo y simula una pulsación BLE.
          </Text>
          <Text style={styles.pipelineText} numberOfLines={3}>{pipelineSummary}</Text>
        </View>

        <View style={styles.panel}>
          <View style={styles.panelHeader}>
            <Icon name="text-box-outline" size={20} color={COLORS.primary} />
            <Text style={styles.panelTitle}>Logs ({logs.length})</Text>
          </View>
          <View style={styles.buttonGrid}>
            <DebugButton icon="share-variant" label="Exportar" onPress={handleExportLogs} />
            <DebugButton icon="delete-outline" label="Borrar" onPress={handleClearLogs} tone="danger" />
          </View>
          <View style={styles.logList}>
            {latestLogs.map((item) => (
              <View key={item.id} style={styles.logRow}>
                <View style={styles.logMeta}>
                  <Text style={[styles.logLevel, { color: LOG_COLORS[item.level] }]}>
                    {item.level.toUpperCase()}
                  </Text>
                  <Text style={styles.logTag}>[{item.tag}]</Text>
                  <Text style={styles.logTime}>{formatTime(item.timestamp)}</Text>
                </View>
                <Text style={styles.logMessage}>{item.message}</Text>
              </View>
            ))}
            {latestLogs.length === 0 ? <Text style={styles.hint}>Aún no hay logs.</Text> : null}
          </View>
        </View>
      </ScrollView>
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
    paddingBottom: 42,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    marginBottom: 14,
  },
  headerIcon: {
    width: 48,
    height: 48,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: `${COLORS.primary}12`,
    borderWidth: 1,
    borderColor: `${COLORS.primary}35`,
  },
  headerText: {
    flex: 1,
  },
  title: {
    fontSize: 24,
    fontWeight: '800',
    color: COLORS.text,
  },
  subtitle: {
    fontSize: 12,
    color: COLORS.textSecondary,
    lineHeight: 17,
    marginTop: 2,
  },
  statusGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginBottom: 14,
  },
  statusPill: {
    width: '48.5%',
    minHeight: 58,
    backgroundColor: COLORS.surface,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  statusLabel: {
    fontSize: 10,
    color: COLORS.textMuted,
    fontWeight: '800',
  },
  statusValue: {
    fontSize: 14,
    fontWeight: '800',
    marginTop: 5,
  },
  panel: {
    backgroundColor: COLORS.surface,
    borderRadius: 10,
    padding: 14,
    marginBottom: 14,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  panelHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 12,
  },
  panelTitle: {
    flex: 1,
    fontSize: 16,
    fontWeight: '800',
    color: COLORS.text,
  },
  buttonGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  debugButton: {
    minHeight: 42,
    minWidth: '47.5%',
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingHorizontal: 10,
    paddingVertical: 9,
    borderRadius: 8,
    backgroundColor: COLORS.background,
    borderWidth: 1,
  },
  debugButtonDisabled: {
    opacity: 0.5,
  },
  debugButtonText: {
    fontSize: 13,
    fontWeight: '700',
  },
  deviceList: {
    marginTop: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: COLORS.border,
  },
  deviceRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: COLORS.border,
  },
  deviceInfo: {
    flex: 1,
  },
  deviceName: {
    fontSize: 13,
    fontWeight: '700',
    color: COLORS.text,
  },
  deviceId: {
    fontSize: 10,
    color: COLORS.textSecondary,
    marginTop: 2,
  },
  hint: {
    fontSize: 12,
    color: COLORS.textSecondary,
    lineHeight: 17,
    marginTop: 10,
  },
  subPanelTitle: {
    fontSize: 12,
    color: COLORS.text,
    fontWeight: '800',
    marginTop: 14,
    marginBottom: 8,
  },
  signaturePanel: {
    marginTop: 12,
    padding: 10,
    borderRadius: 8,
    backgroundColor: COLORS.background,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  signatureTitle: {
    fontSize: 10,
    color: COLORS.textMuted,
    fontWeight: '900',
    marginBottom: 6,
  },
  signatureText: {
    fontSize: 11,
    color: COLORS.textSecondary,
    lineHeight: 16,
    fontFamily: Platform.select({ ios: 'Courier', android: 'monospace', default: 'Courier' }),
  },
  buttonEventRow: {
    padding: 10,
    borderRadius: 8,
    backgroundColor: COLORS.background,
    borderWidth: 1,
    borderColor: COLORS.border,
    marginBottom: 8,
  },
  buttonEventTop: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 5,
  },
  buttonEventTime: {
    fontSize: 10,
    color: COLORS.textMuted,
    fontWeight: '800',
  },
  buttonEventKind: {
    marginLeft: 'auto',
    fontSize: 10,
    color: COLORS.accent,
    fontWeight: '900',
  },
  buttonEventSignature: {
    fontSize: 11,
    color: COLORS.text,
    lineHeight: 15,
    fontFamily: Platform.select({ ios: 'Courier', android: 'monospace', default: 'Courier' }),
  },
  buttonEventBytes: {
    fontSize: 10,
    color: COLORS.textSecondary,
    marginTop: 5,
    fontFamily: Platform.select({ ios: 'Courier', android: 'monospace', default: 'Courier' }),
  },
  resultText: {
    fontSize: 12,
    color: COLORS.textSecondary,
    marginTop: 10,
    fontWeight: '700',
  },
  transcript: {
    marginTop: 8,
    padding: 10,
    borderRadius: 8,
    backgroundColor: COLORS.background,
    color: COLORS.text,
    fontSize: 13,
    lineHeight: 18,
  },
  pipelineText: {
    marginTop: 8,
    color: COLORS.textSecondary,
    fontSize: 12,
    lineHeight: 17,
  },
  logList: {
    marginTop: 12,
  },
  logRow: {
    paddingVertical: 7,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: COLORS.border,
  },
  logMeta: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginBottom: 2,
  },
  logLevel: {
    fontSize: 10,
    fontWeight: '900',
    fontFamily: 'Courier',
  },
  logTag: {
    fontSize: 10,
    color: COLORS.textSecondary,
    fontFamily: 'Courier',
  },
  logTime: {
    marginLeft: 'auto',
    fontSize: 10,
    color: COLORS.textMuted,
  },
  logMessage: {
    fontSize: 12,
    color: COLORS.text,
    lineHeight: 16,
  },
});
