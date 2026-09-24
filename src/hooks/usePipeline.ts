import { useEffect, useCallback, useRef } from 'react';
import { PipelineOrchestrator } from '../services/PipelineOrchestrator';
import { BluetoothService } from '../services/bluetooth';
import { WakeWordService } from '../services/WakeWordService';
import { LogService } from '../services/LogService';
import { LLMService } from '../services/ai';
import { GrokVoice } from '../services/grok-voice';
import { useAppStore } from '../stores';
import type { ConversationMessage } from '../types';

/** Chronological user/assistant messages of the chat shown on Home. */
function getActiveSessionMessages(): ConversationMessage[] {
  const { chatSessions, activeSessionId } = useAppStore.getState();
  const session = chatSessions.find((s) => s.id === activeSessionId);
  if (!session) return [];
  // Entries are stored newest first.
  return [...session.entries]
    .reverse()
    .flatMap((entry) => [entry.userMessage, entry.assistantMessage]);
}

type UsePipelineOptions = {
  /** Called for BLE button presses while the Grok realtime mode is selected. */
  onGrokButtonPress?: () => void;
};

export function usePipeline(options: UsePipelineOptions = {}) {
  const setPipelineState = useAppStore((s) => s.setPipelineState);
  const setTranscription = useAppStore((s) => s.setTranscription);
  const setInterimTranscription = useAppStore((s) => s.setInterimTranscription);
  const setResponse = useAppStore((s) => s.setResponse);
  const setError = useAppStore((s) => s.setError);
  const clearError = useAppStore((s) => s.clearError);
  const addConversationEntry = useAppStore((s) => s.addConversationEntry);
  const setLatencyMetrics = useAppStore((s) => s.setLatencyMetrics);
  const settingsLoaded = useAppStore((s) => s.settingsLoaded);
  const wakeWord = useAppStore((s) => s.settings.wakeWord.trim() || 'KAIRO');
  const wakeWordLang = useAppStore((s) => s.settings.wakeWordLang || 'es-ES');
  const wakeWordCooldownMs = useAppStore((s) => s.settings.wakeWordCooldownMs);
  const wakeWordResumeDelayMs = useAppStore((s) => s.settings.wakeWordResumeDelayMs);
  const wakeWordMinTriggerIntervalMs = useAppStore((s) => s.settings.wakeWordMinTriggerIntervalMs);
  const voiceMode = useAppStore((s) => s.settings.voiceMode);

  const onGrokButtonPressRef = useRef(options.onGrokButtonPress);
  onGrokButtonPressRef.current = options.onGrokButtonPress;

  // Always read the freshest settings/profile at call time.
  const getSettings = () => useAppStore.getState().settings;
  const getProfile = () => useAppStore.getState().userProfile;

  useEffect(() => {
    PipelineOrchestrator.registerCallbacks({
      onStateChange: (state) => {
        setPipelineState(state);
        if (state === 'listening' || state === 'processing') {
          // A new turn replaces whatever error the previous one left behind.
          clearError();
        }
        if (useAppStore.getState().settings.voiceMode === 'grok') return;
        if (state === 'idle') {
          WakeWordService.resume();
        } else if (state === 'speaking' && useAppStore.getState().settings.interruptSpeechWithWakeWord) {
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
      onLatencyUpdate: setLatencyMetrics,
      getContextMessages: getActiveSessionMessages,
    });
  }, [setPipelineState, setTranscription, setInterimTranscription, setResponse, setError, clearError, addConversationEntry, setLatencyMetrics]);

  const startListening = useCallback(() => {
    PipelineOrchestrator.startListening(getSettings(), getProfile(), { source: 'manual' });
  }, []);

  const interruptAndListen = useCallback(() => {
    PipelineOrchestrator.interruptAndListen(getSettings(), getProfile());
  }, []);

  const stopListeningAndProcess = useCallback(() => {
    PipelineOrchestrator.stopListeningAndProcess();
  }, []);

  const sendTextMessage = useCallback((text: string) => {
    PipelineOrchestrator.sendTextMessage(text, getSettings(), getProfile());
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
      if (useAppStore.getState().settings.voiceMode === 'grok') {
        onGrokButtonPressRef.current?.();
        return;
      }
      if (PipelineOrchestrator.isCurrentlyListening()) {
        stopListeningAndProcess();
      } else if (PipelineOrchestrator.isActive() && getSettings().interruptSpeechWithButton) {
        interruptAndListen();
      } else if (!PipelineOrchestrator.isActive()) {
        startListening();
      }
    });

    return unsubscribe;
  }, [interruptAndListen, startListening, stopListeningAndProcess]);

  useEffect(() => {
    LLMService.refreshProxyHealth().catch(() => {});
  }, []);

  // Wake word detection — restarts when its settings change. Waits for the
  // persisted settings so it doesn't start with defaults and restart again.
  useEffect(() => {
    if (!settingsLoaded || voiceMode === 'grok') return undefined;

    WakeWordService.start(wakeWord, (detection) => {
      if (GrokVoice.isActive()) return;
      LogService.info('Pipeline', `Wake word "${wakeWord}" detected - starting pipeline`);
      if (PipelineOrchestrator.isActive()) {
        const activeState = PipelineOrchestrator.getState();
        if (activeState !== 'listening' && getSettings().interruptSpeechWithWakeWord) {
          PipelineOrchestrator.interruptAndListen(getSettings(), getProfile());
        }
        return;
      }
      if (detection?.command) {
        PipelineOrchestrator.sendTextMessage(detection.command, getSettings(), getProfile());
      } else {
        PipelineOrchestrator.startListening(getSettings(), getProfile(), { source: 'wake' });
      }
    }, wakeWordLang, {
      cooldownMs: wakeWordCooldownMs,
      resumeDelayMs: wakeWordResumeDelayMs,
      minTriggerIntervalMs: wakeWordMinTriggerIntervalMs,
    });

    return () => { WakeWordService.stop(); };
  }, [
    settingsLoaded,
    voiceMode,
    wakeWord,
    wakeWordLang,
    wakeWordCooldownMs,
    wakeWordResumeDelayMs,
    wakeWordMinTriggerIntervalMs,
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
