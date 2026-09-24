import { useCallback, useEffect } from 'react';
import { GrokVoice } from '../services/grok-voice';
import { useAppStore } from '../stores';
import type { AppState } from '../types';

/**
 * Wires the GrokVoice service to the same store + UI surface used by the
 * pipeline. Returns start/stop helpers that HomeScreen calls based on
 * settings.voiceMode. Mirrors the shape of usePipeline so the two modes are
 * interchangeable from the UI's perspective.
 *
 * Note: Grok realtime has its own continuous listening loop (server VAD), so
 * the wake-word service is intentionally NOT involved in Grok mode.
 */
export function useGrokVoice() {
  const setPipelineState = useAppStore((s) => s.setPipelineState);
  const setTranscription = useAppStore((s) => s.setTranscription);
  const setResponse = useAppStore((s) => s.setResponse);
  const setError = useAppStore((s) => s.setError);
  const clearError = useAppStore((s) => s.clearError);
  const addConversationEntry = useAppStore((s) => s.addConversationEntry);
  const voiceMode = useAppStore((s) => s.settings.voiceMode);

  const startSession = useCallback(async () => {
    clearError();
    const { settings, userProfile } = useAppStore.getState();
    await GrokVoice.startSession(settings, userProfile, {
      onStateChange: (grokState) => {
        // Map Grok session state → the AppState the rest of the UI already understands.
        const mapped: AppState =
          grokState === 'connecting' ? 'processing' :
          grokState === 'listening' ? 'listening' :
          grokState === 'speaking' ? 'speaking' :
          grokState === 'error' ? 'idle' :
          'idle'; // 'idle' / 'connected'
        setPipelineState(mapped);
      },
      onUserTranscript: (text) => {
        setTranscription(text);
      },
      onResponseDelta: (text) => {
        setResponse(text);
      },
      onResponseFinal: (text) => {
        setResponse(text);
      },
      onConversationEntry: (entry) => {
        addConversationEntry(entry);
        // Clear the live response once the turn is archived.
        setResponse('');
      },
      onError: (message) => {
        setError(message);
        setPipelineState('idle');
      },
    });
  }, [addConversationEntry, clearError, setError, setPipelineState, setResponse, setTranscription]);

  const stopSession = useCallback(async () => {
    await GrokVoice.stopSession();
    setPipelineState('idle');
  }, [setPipelineState]);

  const interrupt = useCallback(() => {
    GrokVoice.interrupt();
  }, []);

  const isActive = useCallback(() => GrokVoice.isActive(), []);

  // Tear down any active Grok session if the user switches back to pipeline mode
  // or unmounts the Home screen.
  useEffect(() => {
    if (voiceMode !== 'grok' && GrokVoice.isActive()) {
      GrokVoice.stopSession().then(() => setPipelineState('idle'));
    }
  }, [voiceMode, setPipelineState]);

  useEffect(() => {
    return () => {
      if (GrokVoice.isActive()) {
        GrokVoice.stopSession().catch(() => {});
      }
    };
  }, []);

  return { startSession, stopSession, interrupt, isActive };
}
