# SMART-GLASSES-AI Agent Notes

## Current Stable State

The currently working iPhone build is the direct Xcode-installed Release archive created on 2026-05-11 after the debug-screen, STT diagnostics, and speech restart stabilization pass. The app is installed on a physical iPhone with bundle id `com.smartglassesai.expo`.

Voice flow confirmed working on device:

- Wake word: `KAIRO`.
- Manual `Hablar` button transcribes correctly.
- Saying `KAIRO` starts listening and then transcribes correctly.
- Text chat works and receives LLM responses.
- BLE glasses button starts STT, records mic volume, produces interim transcripts, finalizes on silence, sends the transcript to the LLM, and speaks the response through native TTS.

Known remaining behavior being tuned:

- Native TTS should prefer the Bluetooth glasses route. The app now explicitly configures the iOS shared audio session for Bluetooth: `playAndRecord` + `allowBluetooth`/`allowBluetoothA2DP`/`allowAirPlay` for speech, and `playback` + A2DP/AirPlay for file playback.
- The remote proxy should be configured with `EXPO_PUBLIC_PROXY_BASE_URL` and served from private deployment infrastructure. It proxies OpenCode/Hermes and Kokoro TTS so provider keys stay server-side.
- Chrome/web is not reliable for voice testing. Web Speech plus microphone routing caused hangs and `Failed to fetch`/CORS issues. Prefer iPhone direct install for voice QA.
- OpenCode reasoning models can return HTTP 200 with empty `message.content` if `max_tokens` is too low. Keep the OpenCode runtime minimum high enough for reasoning models; current minimum is 1024 tokens.
- The default LLM request timeout is 90000ms. Settings migrations are one-shot and gated by `settingsVersion` (`SETTINGS_SCHEMA_VERSION` in `src/stores/useAppStore.ts`); bump it and add a guarded block when a new migration is needed, never run migrations unconditionally on every load.
- The turn timeout only aborts before audio starts (plus one extension while speaking) so answers are not cut mid-sentence.

## Product Identity

- The assistant name is `KAIRO`.
- The visible chat assistant label must be the active wake word, normally `KAIRO`.
- Do not reintroduce `JARVIS` as a visible product name. `jarvis` may appear only as legacy migration data for old saved settings.
- The wake word settings should center on `KAIRO`; custom activation remains available for diagnostics.

## Architecture

- Expo SDK 54 / React Native app.
- Native iOS project is generated under `ios/` by `npx expo prebuild --platform ios` and is ignored by git.
- Important app files:
  - `src/services/WakeWordService.ts`: passive wake word listener.
  - `src/services/ai/STTService.ts`: main speech-to-text listener after button or wake word.
  - `src/services/PipelineOrchestrator.ts`: state machine for listen -> transcribe -> LLM -> TTS.
  - `src/services/ai/LLMService.ts`: LLM providers, OpenCode default.
  - `src/services/ai/TTSService.ts`: native and remote TTS.
  - `src/services/ai/StreamingTtsPlayer.ts`: low-latency Kokoro streaming path (PCM into the native ring buffer).
  - `src/services/audio/AudioService.ts`: iOS audio session and audio file playback.
  - `modules/grok-audio/`: native iOS module (`expo-grok-audio`). Provides bidirectional PCM streaming for the Grok realtime path AND playback-only streaming for the cheap Kokoro pipeline. Requires a native build (dev-client), not Expo Go.
  - `src/services/grok-voice/`: Grok realtime WebSocket client + orchestrator (premium voice mode).
  - `src/services/LogService.ts`: in-app logs, persisted for diagnostics.
  - `src/screens/Home/HomeScreen.tsx`: main chat and voice UI.
  - `src/screens/Settings/SettingsScreen.tsx`: settings, diagnostics, logs.
  - `src/components/ui.tsx`: shared UI kit (Card, Button, OptionGroup, ToggleRow, ScreenHeader…). Use it plus the tokens in `src/constants` (`COLORS`, `RADIUS`, `withAlpha`) instead of ad-hoc styles.
  - `src/services/ai/speechText.ts`: strips Markdown/emojis/URLs before any TTS.

## Voice Details

- `KAIRO` wake word works through `expo-speech-recognition`.
- The key STT fix is a handoff delay in `PipelineOrchestrator` before starting STT on iOS after stopping the wake listener.
- Do not remove the iOS handoff delay unless testing proves it is safe.
- `STTService` diagnostics must stay off the critical path after `ExpoSpeechRecognitionModule.start()`. `getStateAsync()` can hang or time out on device; it is intentionally logged in the background.
- `STTService` and `WakeWordService` guard speech-recognition restarts so `no-speech`/`end` events cannot stack multiple pending starts. Without that guard, iOS can enter repeated `audio-capture` errors and appear stuck on "escuchando".
- `STTService` intentionally does not use persisted recording options on native iOS, because the wake listener transcribed correctly without them and the persisted recording path interfered with the main recognizer.
- `WakeWordService` logs throttled mic volume and heard hypotheses on native iOS for diagnostics. This is expected and useful when testing wake word sensitivity.
- OpenCode responses must be parsed from visible answer fields only. Do not use `reasoning_content` as the assistant reply.
- The LLM receives the last 6 turns of the active chat as context, except Hermes, which keeps its own server-side session via `X-Hermes-Session-Key`.
- `expo-grok-audio` exposes `getBufferedDurationMs()`; `StreamingTtsPlayer.finish()` waits for the native buffer to drain before the session is torn down. Older native builds return -1 and fall back to a duration estimate.
- Useful logs in Settings -> Diagnósticos -> Logs:
  - `WakeWord`: wake phrase detection.
  - `STT`: permissions, audio start/end, speech start/end, transcript.
  - `Pipeline`: state transitions and LLM/TTS timing.
  - `TTS` and `Audio`: playback route preparation and synthesis/playback.

## API And Env

- Local env file is named `env` and contains real secrets. Never print it and never commit it.
- `app.config.js` loads both `.env` and `env` so Expo can read `EXPO_PUBLIC_*` values.
- Do not put provider API keys in `EXPO_PUBLIC_*`. Mobile bundles must not read API keys from env. `SecureStorage` now reads only manual secure-store entries; production traffic should use the backend proxy so provider keys stay server-side.
- `XAI_API_KEY` (Grok realtime) lives only in `server/.env` if/when Grok is enabled. The app never receives it; the proxy mints a short-lived ephemeral token (`xai-client-secret.*`) via `/api/v1/xai/realtime/session` and the WebSocket connects directly to `api.x.ai`. Same rule: never expose this key in the mobile bundle.
- Current testing priority: do not use Grok by default. Keep using the cheap pipeline with OpenCode/Hermes plus Kokoro streaming TTS, and evaluate cheaper alternatives before enabling premium Grok voice sessions.
- Default LLM provider: `opencode`.
- Default model: `deepseek-v4-flash`.
- `deepseek-v4-flash` is the preferred fast OpenCode model. Stored `glm-5.1`/`glm-5` settings are migrated back to it on load.
- OpenCode tries the backend proxy first on all platforms, then falls back to a manually saved secure key only if the proxy is unavailable.
- Private VPS SSH details, key paths, and hostnames must stay out of git. Gunicorn runs on `0.0.0.0:5050` behind the configured public proxy URL.
- The remote health endpoint should report `opencode_configured: true`, `hermes_configured: true`, `device_auth_enabled: true`, and `kokoro_enabled: true` once Kokoro is enabled in the server `.env`.
- Kokoro streaming test:

```sh
python server/test_kokoro_stream.py --base https://your-proxy.example.com --token <DEVICE_TOKEN>
```
- OpenCode direct calls from Chrome are blocked by CORS. For web testing, run the local proxy and start Expo with:

```sh
EXPO_PUBLIC_PROXY_BASE_URL=http://localhost:5050 npx expo start
```

Local proxy:

```sh
cd server
./.venv/bin/python server.py
```

If using the proxy locally, load secrets from `../env` and set `APP_TOKEN`/`CORS_ORIGINS` as done in prior sessions. Do not commit generated `server/.venv`.

## iOS Build And Install

Useful commands:

```sh
npm run typecheck
npx expo prebuild --platform ios
cd ios && pod install --repo-update
xcodebuild archive -workspace ios/SmartGlassesAI.xcworkspace -scheme SmartGlassesAI -configuration Release -destination generic/platform=iOS -archivePath build/SmartGlassesAI.xcarchive -allowProvisioningUpdates DEVELOPMENT_TEAM=<APPLE_TEAM_ID> CODE_SIGN_STYLE=Automatic
xcrun devicectl list devices
xcrun devicectl manage pair --device <DEVICE_ID>
xcrun devicectl device install app --device <DEVICE_ID> build/SmartGlassesAI.xcarchive/Products/Applications/SmartGlassesAI.app
xcrun devicectl device process launch --device <DEVICE_ID> --terminate-existing com.smartglassesai.expo
```

The iPhone previously paired/used:

- Name: physical iPhone
- Device id for `devicectl`: `<DEVICE_ID>`
- Model: iPhone

Latest direct iPhone install:

- Archive: `build/SmartGlassesAI-sttfix-8.xcarchive`
- Installed and launched on a physical iPhone on 2026-05-11.
- Verified voice sample: BLE button -> STT interim results -> final transcript `"La llevo me la llevo si quieres"` -> LLM response -> native TTS.
- Verification before install: `npm run typecheck` passed, archive succeeded, and `rg` found no API key env references in the built `.app` archive.

## TestFlight

The latest upload to App Store Connect succeeded:

- App Store Connect app: `SmartGlasses AI`
- App id: `6761984215`
- Bundle id: `com.smartglassesai.expo`
- Version: `1.0.0`
- Build: `2`
- Uploaded on 2026-05-08 from `build/SmartGlassesAI-testflight-2.xcarchive`.
- Upload status in Xcode logs: succeeded; App Store Connect reported the package is processing.
- Non-blocking symbol warnings were reported for React/Hermes dSYMs during upload.

If the build does not appear in TestFlight, check App Store Connect for processing, missing export compliance, or missing internal tester group assignment.

## Git Hygiene

- `env`, `.env*`, `build/`, `ios/`, `android/`, and `server/.venv` must stay ignored.
- Avoid committing archives or secrets.
- Run `npm run typecheck` before committing voice or settings changes.
