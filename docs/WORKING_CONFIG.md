# SmartGlasses AI — Working Configuration (v0.8.3)

> Last verified: direct iPhone install on a physical iPhone, archive `build/SmartGlassesAI-sttfix-8.xcarchive`, 2026-05-11

## Confirmed Working

- **STT**: `expo-speech-recognition` (native Apple Speech, on-device, Spanish)
- **LLM**: OpenCode default provider with `deepseek-v4-flash`
- **TTS**: `expo-speech` (native iOS voices, routes through BLE glasses speakers)
- **BLE**: `react-native-ble-plx` connecting to AiMB-S1 glasses
- **Wake Word**: `KAIRO` via continuous `expo-speech-recognition`
- **BLE Button Voice Flow**: glasses button starts STT, detects mic volume, emits interim transcripts, finalizes on silence, sends to LLM, and speaks via native TTS
- **Interim Transcription**: Real-time speech-to-text shown in UI while speaking

## Infrastructure

| Component | Value |
|-----------|-------|
| Proxy URL | `https://your-proxy.example.com` |
| App Token | Stored server-side; never commit real tokens |
| VPS SSH | Private deployment detail; do not commit host/user values |
| Bundle ID | `com.smartglassesai.expo` |
| Apple Team | Set locally in Xcode or CI secrets |
| EAS Profile | `testflight` |

## Key Technical Details

### STT Race Condition Fix
- iOS only allows ONE `ExpoSpeechRecognitionModule` session at a time
- WakeWordService must `pause()` before STTService can `start()`
- 400ms delay between WakeWord pause and STT start
- 300ms abort-to-start delay inside STTService
- `silenceAlreadyFired` guard prevents double-fire of silence callback
- Speech-engine state diagnostics are fire-and-forget after `start()`; do not await `getStateAsync()` on the critical path
- `no-speech` and `end` handlers use a single pending restart timer so repeated native events cannot stack overlapping `start()` calls
- Wake-word restarts are also guarded by a single pending restart timer to prevent repeated `audio-capture` failures

### TTS Bluetooth Audio Routing
- `setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true })` BEFORE playback
- This makes iOS route audio through Bluetooth output (glasses speakers)
- Without this call, audio plays through iPhone speaker only

### Pipeline Flow
```
1. Trigger (mic button / BLE button / wake word)
2. WakeWordService.pause()
3. await delay(400ms)  // let iOS release audio session
4. STTService.start()  // captures speech with interim results
5. STTService.stop()   // on silence or manual stop
6. LLMService.chat()   // sends transcript to MiniMax
7. TTSService.synthesize()  // generates speech
8. AudioService.playAudio()  // plays through BLE speakers
9. WakeWordService.resume()  // back to passive listening
```

### 2026-05-11 Device Verification
- Installed archive: `build/SmartGlassesAI-sttfix-8.xcarchive`
- Device: physical iPhone
- Confirmed log sequence: BLE notification -> `Speech recognition started - listening` -> mic volume -> interim STT results -> final transcript -> LLM response -> native TTS
- Confirmed sample transcript: `"La llevo me la llevo si quieres"`
- Remaining latency note: if the remote proxy route is unavailable, the app may fall back to a manually saved device key for local testing only

### BLE Connection
- Scans for devices with name prefixes: `AiMB`, `AIMB`, `Smart`, `Glasses`
- Checks already-connected BLE peripherals first
- Checks saved device ID from AsyncStorage
- Falls back to active 15s scan
- Auto-reconnects on disconnect (5s delay)
- Subscribes to all notifiable characteristics for button events

## Dependencies (Critical)

| Package | Version | Purpose |
|---------|---------|---------|
| expo | ~54.0.0 | Framework |
| react-native | 0.81.5 | Runtime |
| expo-speech-recognition | ^3.1.2 | STT + Wake Word |
| expo-audio | ~1.1.1 | Audio playback/recording |
| expo-speech | ~13.1.3 | Native TTS |
| react-native-ble-plx | ^3.5.1 | BLE connection |
| zustand | ^5.0.5 | State management |
| @react-native-async-storage/async-storage | 2.1.2 | Persistence |

## Build Commands

```bash
# TypeScript check
npx tsc --noEmit

# Build for TestFlight
eas build --profile testflight --platform ios --non-interactive

# Submit to TestFlight
eas submit --profile testflight --platform ios --non-interactive --latest
```
