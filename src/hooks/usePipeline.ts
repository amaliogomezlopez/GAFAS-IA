import { useEffect, useCallback, useRef } from 'react';
import { PipelineOrchestrator } from '../services/PipelineOrchestrator';
import { BluetoothService } from '../services/bluetooth';
import { WakeWordService } from '../services/WakeWordService';
import { LogService } from '../services/LogService';
import { LLMService } from '../services/ai';
import { useAppStore } from '../stores';

export function usePipeline() {
  const {
    setPipelineState,
    setTranscription,
    setInterimTranscription,
    setResponse,
    setError,
    addConversationEntry,
    setLatencyMetrics,
    settings,
    userProfile,
  } = useAppStore();

  const settingsRef = useRef(settings);
  const userProfileRef = useRef(userProfile);
  settingsRef.current = settings;
  userProfileRef.current = userProfile;

  useEffect(() => {
    PipelineOrchestrator.registerCallbacks({
      onStateChange: (state) => {
        setPipelineState(state);
        if (state === 'idle') {
          WakeWordService.resume();
        } else if (state === 'speaking' && settingsRef.current.interruptSpeechWithWakeWord) {
          WakeWordService.resume({ cooldownMs: 120, delayMs: 80 });
        } else {
          WakeWordService.pause();
        }
      },
      onTranscription: setTranscription,
      onInterimTranscription: setInterimTranscription,
      onResponse: setResponse,
      onError: setError,
      onConversationEntry: addConversationEntry,
      onLatencyUpdate: (metrics) => {
        if (setLatencyMetrics) setLatencyMetrics(metrics);
      },
    });
  }, [setPipelineState, setTranscription, setInterimTranscription, setResponse, setError, addConversationEntry, setLatencyMetrics]);

  const startListening = useCallback(async () => {
    PipelineOrchestrator.startListening(settingsRef.current, userProfileRef.current, { source: 'manual' });
  }, []);

  const interruptAndListen = useCallback(async () => {
    PipelineOrchestrator.interruptAndListen(settingsRef.current, userProfileRef.current);
  }, []);

  const stopListeningAndProcess = useCallback(() => {
    PipelineOrchestrator.stopListeningAndProcess();
  }, []);

  const sendTextMessage = useCallback((text: string) => {
    PipelineOrchestrator.sendTextMessage(text, settingsRef.current, userProfileRef.current);
  }, []);

  const cancelListening = useCallback(() => {
    PipelineOrchestrator.cancelListening();
  }, []);

  const forceStop = useCallback(() => {
    PipelineOrchestrator.forceStop();
  }, []);

  // BLE button press subscription
  useEffect(() => {
    const unsubscribe = BluetoothService.subscribe(() => {
      LogService.info('Pipeline', 'BLE button press received');
      if (PipelineOrchestrator.isCurrentlyListening()) {
        stopListeningAndProcess();
      } else if (PipelineOrchestrator.isActive() && settingsRef.current.interruptSpeechWithButton) {
        interruptAndListen();
      } else if (!PipelineOrchestrator.isActive()) {
        startListening();
      }
    });

    return unsubscribe;
  }, [interruptAndListen, startListening, stopListeningAndProcess]);

  // Wake word detection — restart when wakeWord setting changes
  const wakeWord = settings.wakeWord || 'KAIRO';
  const wakeWordLang = settings.wakeWordLang || 'es-ES';
  useEffect(() => {
    LLMService.refreshProxyHealth().catch(() => {});

    WakeWordService.start(wakeWord, (detection) => {
      LogService.info('Pipeline', `Wake word "${wakeWord}" detected - starting pipeline`);
      if (PipelineOrchestrator.isActive()) {
        const activeState = PipelineOrchestrator.getState();
        if (
          activeState !== 'listening' &&
          settingsRef.current.interruptSpeechWithWakeWord
        ) {
          PipelineOrchestrator.interruptAndListen(settingsRef.current, userProfileRef.current);
        }
        return;
      }
      if (detection?.command) {
        PipelineOrchestrator.sendTextMessage(detection.command, settingsRef.current, userProfileRef.current);
      } else {
        PipelineOrchestrator.startListening(settingsRef.current, userProfileRef.current, { source: 'wake' });
      }
    }, wakeWordLang, {
      cooldownMs: settings.wakeWordCooldownMs,
      resumeDelayMs: settings.wakeWordResumeDelayMs,
      minTriggerIntervalMs: settings.wakeWordMinTriggerIntervalMs,
    });

    return () => { WakeWordService.stop(); };
  }, [
    settings.wakeWordCooldownMs,
    settings.wakeWordMinTriggerIntervalMs,
    settings.wakeWordResumeDelayMs,
    startListening,
    wakeWord,
    wakeWordLang,
  ]);

  return {
    startListening,
    stopListeningAndProcess,
    sendTextMessage,
    cancelListening,
    forceStop,
    interruptAndListen,
  };
}
