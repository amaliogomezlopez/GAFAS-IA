# Changelog

## [Unreleased]

### Added — Modo de voz sub-segundo barato (OpenCode/Hermes + Kokoro streaming)
- **Pipeline de baja latencia**: nuevo `StreamingTtsPlayer` que pide cada frase a la ruta `/api/v1/tts/kokoro/stream` (PCM16 crudo en streaming, no blob) y alimenta el ring buffer nativo (`expo-grok-audio`) en cuanto llega cada chunk. Solapa generación LLM + síntesis TTS + reproducción (patrón hypercheap-voiceAI).
- **Ruta proxy Kokoro streaming** (`server.py`): emite PCM16 24kHz mono segmento a segmento sin contenedor WAV ni temp file, con cabeceras `X-Audio-*`.
- **Módulo nativo `expo-grok-audio`** ampliado con `startPlaybackSession` / `stopPlaybackSession` / `clearPlayback` para el camino barato (playback-only, reutiliza el ring buffer y el routing Bluetooth de las gafas).
- **Instrumentación de latencia** por etapa: logs `[latency] first_token=… first_audio=… total=…` y `onLatencyUpdate` con `llmMs`=first_token y `ttsMs`=first_audio para medir el objetivo sub-segundo.
- **Barge-in instantáneo** en el camino Kokoro: `forceStop` limpia el ring buffer y aborta los fetch en vuelo.

### Changed — Respuestas forzadas más cortas (latencia + coste)
- Preset «Ultra-rápido»: `maxTokens` 160 → 96; instrucción reforzada a "una sola frase corta, máximo 15 palabras, sin emojis". La palanca más barata de latencia/coste.
- Ajuste de los `responseInstructionMap` (instant/balanced/natural) hacia respuestas más compactas.

### Added — Modo de voz Grok Realtime (premium, opcional)
- **Ruta proxy** `POST /api/v1/xai/realtime/session` que acuña un token efímero (`xai-client-secret.*`, ~5 min) contra x.ai; la API key maestra `XAI_API_KEY` nunca sale del servidor.
- **Cliente TS** `GrokRealtimeClient` (WebSocket Realtime compatible OpenAI) + orquestador `GrokVoice`.
- **Tipos/constantes/store**: `VoiceMode` ('pipeline' | 'grok'), `grokVoiceId`, `GROK_VOICES` (eve/ara/rex/sal/leo), migración de settings.
- **UI Settings**: selector de «Modo de Voz» (Pipeline vs Grok Realtime) y selector de voz de Grok.
- Requiere dev-client nativo en iOS (no Expo Go); las voces nativas de Grok tienen coste (~$0.05/min).

## [0.8.3] - 2026-05-11

### Fixed
- **iPhone STT stuck on "escuchando"**: moved speech-engine diagnostics off the critical path after `ExpoSpeechRecognitionModule.start()`, because `getStateAsync()` can time out on device and delay the pipeline from entering the listening state cleanly.
- **Stacked speech-recognition restarts**: added a single pending restart guard for `no-speech`/`end` events in STT and wake-word listening. This prevents overlapping `start()` calls that caused repeated iOS `audio-capture` failures.
- **Startup diagnostics log loss**: `LogService.load()` now merges persisted and in-memory logs instead of overwriting startup logs, preserving early device diagnostics.

### Changed
- **Wake-word diagnostics**: native iOS wake listening now logs throttled mic volume and heard hypotheses, making the debug screen useful for checking whether the microphone and Apple Speech are receiving audio.

### Verified
- Direct Xcode install on a physical iPhone from `build/SmartGlassesAI-sttfix-8.xcarchive`.
- BLE button flow now records mic volume, emits interim results, finalizes the transcript, sends it to OpenCode, and speaks the response through native TTS.
- Confirmed sample transcript: `"La llevo me la llevo si quieres"`.
- `npm run typecheck` passed before the device build.

## [0.8.2] - 2026-04-30

### Added
- **OpenCode Go LLM Provider**: Added API key storage, model picker options, and OpenAI-compatible chat support for OpenCode Go.
- **NVIDIA Build / NIM LLM Provider**: Added API key storage, model picker options, and OpenAI-compatible chat support via `integrate.api.nvidia.com`.

## [0.7.0] - 2025-07-18

### Critical Bug Fixes
- **Wake Word Infinite Loop**: TTS audio being picked up by the microphone would re-trigger the wake word, causing an infinite conversation loop. Fixed by adding a 3.5s cooldown window after pipeline completion, 5s minimum trigger interval, and 2s delay before resuming wake word recognition.
- **"Hola gafas" Not Reacting**: Removed `setAudioModeAsync` calls from WakeWordService that were interfering with iOS `expo-speech-recognition` audio session management. Speech recognition now manages its own audio session.
- **Pipeline State Desync**: Replaced dual boolean flags (`isProcessing`/`isListening`) with a single `PipelineState` enum and `setState()` helper. Prevents overlapping states like listening+speaking.

### Added
- **Force Stop**: New `forceStop()` method kills STT, AudioService, and expo-speech immediately. Accessible via a red stop button during processing/speaking states.
- **Pipeline Latency Metrics**: Full timing instrumentation (STT, LLM, TTS, total) displayed in a HUD widget on the home screen.
- **Arc Reactor UI**: Complete Stark Industries-themed redesign with animated arc reactor core, HUD status indicators, and chat-style conversation bubbles.
- **AI Personality Presets**: Four presets (J.A.R.V.I.S., Neutral, Amigable, Técnico) in Settings that set the system prompt style. JARVIS is the default.
- **Post-TTS Buffer**: 800ms idle delay after TTS finishes to account for BLE speaker audio latency before resuming wake word.

### Changed
- **Color Palette**: New Stark Industries design system — arc reactor cyan (#00D4FF), deep space black (#060A12), gold-orange accent (#FF6B35).
- **State Labels**: Updated StatusBar icons and labels to match the new theme.
- **HomeScreen**: Replaced flat hero with interactive arc reactor, chat-style conversation view with aligned bubbles, latency HUD display.
- **WakeWord→STT Transition**: Reduced from 400ms to 300ms for faster pipeline startup.

## [0.6.0] - 2025-07-17

### Fixed
- **Static Sound Through Glasses**: WakeWordService continuous microphone caused audio feedback through BLE glasses speakers. Now sets `allowsRecording: true, playsInSilentMode: false` during wake word listening to prevent audio routing to speakers, and restores normal audio mode when pausing.
- **Custom Wake Word Not Saving**: Settings (including wake word) were not persisted to AsyncStorage. Added `loadSettings()` at app startup and auto-persist on every `updateSettings()` call. Wake word changes now immediately restart WakeWordService with new phrase.
- **Keyboard Covering Chat Input**: Added `KeyboardAvoidingView` with `behavior="padding"` on iOS to HomeScreen so the text input bar stays above the keyboard.

### Added
- **Voice Demo/Preview**: Each TTS voice chip in Settings now has a play button (▶) that synthesizes "Hola, soy tu asistente de voz." to preview the voice before selecting it.
- **Auto-detect BLE Connection**: On app launch, automatically checks for already-connected BLE peripherals (from iOS Bluetooth settings) and saved device ID, then auto-connects without requiring manual scan.
- **Settings Persistence**: All app settings (LLM provider, TTS voice, wake word, system prompt, etc.) are now saved to AsyncStorage and loaded on startup.
- **Working Config Documentation**: Added `docs/WORKING_CONFIG.md` with verified infrastructure, pipeline flow, and technical details.

### Changed
- **WakeWordService**: Added `expo-audio` import for `setAudioModeAsync`. Sets recording mode during passive listening to prevent BLE speaker feedback, restores playback mode on pause.
- **usePipeline**: Wake word effect now depends on `settings.wakeWord` so it restarts when user changes the wake phrase.
- **useBluetooth**: Calls `BluetoothService.tryAutoConnect()` after initialization.
- **BluetoothService**: New `tryAutoConnect()` method checks already-connected peripherals matching glasses name prefixes, then tries saved device ID.
- **useAppStore**: `updateSettings()` now persists to AsyncStorage. Added `loadSettings()` action.
- **App.tsx**: Calls `loadSettings()` on startup.

## [0.5.0] - 2025-07-17

### Fixed
- **STT Race Condition**: WakeWordService and STTService both used `ExpoSpeechRecognitionModule` — iOS only allows one session at a time. Added 400ms delay between WakeWord pause and STT start, plus 300ms abort-to-start delay inside STTService. Fixed double-fire of silence callback with `silenceAlreadyFired` guard.
- **TTS Audio Not Playing Through Glasses**: `AudioService.playAudio()` now calls `setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true })` before playback, enabling iOS to route audio through Bluetooth output (glasses).
- **AudioService Promise**: `playAudio()` now returns a Promise that resolves when playback finishes (was fire-and-forget).

### Added
- **Real-time Interim Transcription**: Speech recognition now shows live transcription in the PipelineBanner and conversation area as the user speaks. Uses `onInterimCallback` through STTService → PipelineOrchestrator → usePipeline → useAppStore → HomeScreen.
- **Extensive TTS Logging**: All TTS providers (OpenAI, ElevenLabs, MiniMax, Native) now log synthesis start, audio size, file save, and completion via LogService.
- **STT Event Logging**: All speech recognition events (`start`, `audiostart`, `audioend`, `result`, `end`, `error`) are now logged via LogService for debugging.

### Changed
- **STTService**: Full rewrite with race condition fix, interim callbacks, extensive event logging, `getCurrentTranscript()` method.
- **PipelineOrchestrator**: Added `onInterimTranscription` callback type, passes interim callback to STTService.
- **usePipeline**: Made `startListening` async with 400ms delay after WakeWord pause, wired interim transcription to store.
- **useAppStore**: Added `interimTranscription` state and `setInterimTranscription` action. `setTranscription` now clears interim.
- **HomeScreen**: PipelineBanner shows live interim text while listening. Conversation area shows interim transcription with italic styling.

## [0.4.0] - 2025-07-16

### Added
- **In-app Log Viewer**: Settings → Diagnósticos → Ver Logs. Color-coded by level (error/warn/info/debug), exportable via Share, clearable.
- **Pipeline Test Button**: Settings → Diagnósticos → Probar Pipeline. Sends a test message to verify LLM connectivity, shows response time.
- **LogService** (`src/services/LogService.ts`): Centralized in-memory + AsyncStorage log system with subscribe/export/persist.
- **Wake Word Detection** (`src/services/WakeWordService.ts`): Passive continuous speech recognition that triggers pipeline when "Hola gafas" (configurable) is detected.
- **BLE Button Press via Notifications**: After BLE connection, discovers all services/characteristics, subscribes to ALL notifiable characteristics. Non-battery notifications trigger voice pipeline.
- **Chat Sessions**: Conversations are now organized into sessions with auto-creation, naming, renaming, and individual deletion.
- **History Screen rewrite**: Sessions are expandable cards showing date, message count. Pencil icon to rename, trash icon to delete session, X to delete individual messages.

### Changed
- **PipelineOrchestrator**: Full LogService instrumentation — logs STT start/stop, transcription, LLM request/response with timing, TTS status, and all errors.
- **BluetoothService**: Added `_discoverAndSubscribe()` that logs every service/characteristic with properties (R/W/N/I) and subscribes to notifications.
- **usePipeline hook**: Integrates WakeWordService (pause/resume with pipeline state), BLE button press logging, uses refs for settings to avoid stale closures.
- **useAppStore**: New session management methods (`createSession`, `renameSession`, `deleteSession`, `deleteEntry`, `loadSessions`, `persistSessions`).
- **SettingsScreen**: Updated wake word description text; added Diagnósticos section.
- **App.tsx**: Loads chat sessions on startup.

## [0.3.0] - 2025-07-14

### Fixed
- **STT 404 Error**: MiniMax has no STT API. Replaced with `expo-speech-recognition` for native on-device speech recognition (Apple Speech framework).
- **BLE Scan**: Wasn't finding paired glasses. Now checks already-connected BLE peripherals and saved device IDs before active scan.
- **Dev Client Warning**: Removed confusing "Run in Expo Dev Client" text.

### Added
- Web Bluetooth scanner tool (`ble-scanner.html`) for discovering glasses services/characteristics from desktop browser.

## [0.2.0] - 2025-07-12

### Added
- **EAS Build + TestFlight**: Configured `testflight` profile in `eas.json`; provider keys should stay server-side or in private CI secrets.
- **Profile Screen**: User photo picker, name, birthday. Profile photo as tab icon.
- **ProfileSelector** component on HomeScreen.
- **StatusBar** with BLE connection status and device name.
- **HomeScreen redesign**: Hero section with profile greeting + action cards (Hablar, Escribir, Ajustes).

### Fixed
- **EAS Build 10.7 GB error**: Root cause was `.git` at parent directory. Fixed with `git init` inside SmartGlassesExpo + `.easignore`.
- **TTS 60s timeout**: Fixed expo-speech hanging on long responses.

## [0.1.0] - 2025-07-10

### Added
- Initial Expo project setup (SDK 54, React Native 0.81.5, TypeScript 5.9.2).
- **MiniMax M2.7** integration via Anthropic-compatible API (`api.minimax.io/anthropic/v1/messages`).
- **Native TTS** via `expo-speech`.
- **react-native-ble-plx** for BLE communication with AiMB-S1 glasses.
- Pipeline architecture: STT → LLM → TTS orchestration.
- Zustand store for state management.
- Bottom tab navigation (Home, History, Settings, Profile).
- Secure API key storage via `expo-secure-store`.
