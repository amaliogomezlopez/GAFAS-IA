# SmartGlasses AI — Project Documentation

## Overview

React Native (Expo SDK 54) app for **AiMB-S1** smart glasses. Voice-first AI assistant that listens, thinks, and speaks back.

**Bundle ID:** `com.smartglassesai.expo`  
**Apple Team:** configure locally or in CI secrets  
**GitHub:** [amaliogomezlopez/SMART-GLASSES-AI](https://github.com/amaliogomezlopez/SMART-GLASSES-AI)

---

## Architecture

```
iPhone ↔ AiMB-S1 Glasses (BLE)
  │
  ├─ STT: expo-speech-recognition (native Apple Speech)
  ├─ LLM: MiniMax M2.7 via api.minimax.io/anthropic/v1/messages
  ├─ TTS: expo-speech (native iOS voices)
  └─ State: Zustand + AsyncStorage
```

### Pipeline Flow

1. **Trigger** — User presses app button, glasses button (BLE notification), or says wake word ("Hola gafas")
2. **STT** — `expo-speech-recognition` transcribes speech to text (on-device, Spanish)
3. **LLM** — `LLMService.chatMiniMax()` sends transcript to MiniMax with Anthropic-compatible format
4. **TTS** — `expo-speech` reads the response aloud via native iOS engine
5. **Store** — Conversation entry saved to Zustand store + AsyncStorage session

### Key Services

| Service | File | Purpose |
|---------|------|---------|
| PipelineOrchestrator | `src/services/PipelineOrchestrator.ts` | Orchestrates STT→LLM→TTS chain |
| LLMService | `src/services/ai/LLMService.ts` | Multi-provider LLM (MiniMax, OpenAI, Anthropic, Google, OpenCode Go, NVIDIA Build/NIM) |
| STTService | `src/services/ai/STTService.ts` | Native speech-to-text via expo-speech-recognition |
| TTSService | `src/services/ai/TTSService.ts` | Native TTS + MiniMax TTS fallback |
| BluetoothService | `src/services/bluetooth/BluetoothService.ts` | BLE scan, connect, battery, button notifications |
| WakeWordService | `src/services/WakeWordService.ts` | Passive "Hola gafas" detection via continuous STT |
| LogService | `src/services/LogService.ts` | In-app log capture for debugging |
| SecureStorage | `src/services/secure-storage/` | API key storage via expo-secure-store |

---

## AiMB-S1 Smart Glasses Hardware

- **Red button**: Photo/video (handled by glasses firmware)
- **Black button**: Voice command — triggers BLE notification → app pipeline
- **BLE name**: `AiMB-S1_XXXX` (e.g., `AiMB-S1_9CED`)
- **Services**: Standard BLE services (Battery 0x180F) + custom notification characteristics for button events
- **Connection flow**: App scans → finds AiMB-S1 → connects → discovers services → subscribes to all notifiable characteristics

---

## API Configuration

### MiniMax M2.7

- **Chat endpoint**: `https://api.minimax.io/anthropic/v1/messages`
- **Header**: `x-api-key: <API_KEY>`, `anthropic-version: 2023-06-01`
- **Format**: Anthropic Messages API compatible
- **Model ID**: `MiniMax-M2.7`
- **TTS endpoint**: `https://api.minimaxi.com/v1/t2a_v2` (optional, not used by default)

### API Key Setup

1. **Recommended**: keep provider keys server-side behind the proxy.
2. **App Settings**: developers can add/change keys in Settings → API Keys for local testing.
3. **Storage**: `expo-secure-store`; do not commit or publish provider keys in `EXPO_PUBLIC_*` variables.

### Optional LLM Providers

- **OpenCode Go**: OpenAI-compatible endpoint at `https://opencode.ai/zen/go/v1/chat/completions`. Prefer the proxy; use Settings for local testing keys.
- **NVIDIA Build / NIM**: OpenAI-compatible endpoint at `https://integrate.api.nvidia.com/v1/chat/completions`. Prefer the proxy; use Settings for local testing keys.

---

## Development

### Prerequisites

- Node.js ≥ 18
- Expo CLI: `npm install -g expo-cli`
- EAS CLI: `npm install -g eas-cli`
- Xcode 15+ (for iOS builds)

### Install & Run

```bash
cd SmartGlassesExpo
npm install
npx expo start
```

### Build for TestFlight

```bash
eas build -p ios --profile testflight
eas submit -p ios
```

### Project Structure

```
SmartGlassesExpo/
├── App.tsx                 # Root component, loads profile + sessions
├── app.json                # Expo config (permissions, plugins)
├── eas.json                # EAS build profiles
├── docs/                   # Project documentation
│   ├── CHANGELOG.md
│   └── PROJECT.md
├── src/
│   ├── components/         # Reusable UI (ActionButton, StatusBar, PulseIndicator, ProfileSelector)
│   ├── constants/          # Colors, API endpoints, default settings, models/voices
│   ├── hooks/              # usePipeline (main), useBluetooth
│   ├── navigation/         # Bottom tab navigator
│   ├── screens/            # Home, History, Settings, Profile
│   ├── services/           # Business logic
│   │   ├── ai/             # LLM, STT, TTS services
│   │   ├── audio/          # Audio recording/playback
│   │   ├── bluetooth/      # BLE service
│   │   ├── secure-storage/ # API key storage
│   │   ├── LogService.ts   # In-app logging
│   │   ├── WakeWordService.ts # Wake word detection
│   │   └── PipelineOrchestrator.ts # Voice pipeline
│   ├── stores/             # Zustand state (useAppStore)
│   └── types/              # TypeScript types
```

---

## Debugging

### In-App Logs

Go to **Settings → Diagnósticos → Ver Logs** to see all pipeline events:
- STT start/stop timing
- Transcription text
- LLM request/response with latency
- TTS playback status
- BLE connection, service discovery, notifications
- Wake word detection events
- All errors with stack traces

### Pipeline Test

**Settings → Diagnósticos → Probar Pipeline** sends a test message to the LLM and shows the response with timing. This verifies API key, network connectivity, and model availability.

### Common Issues

| Problem | Likely Cause | Check |
|---------|-------------|-------|
| No AI response | API key missing or invalid | Settings → Probar Pipeline |
| STT not working | Microphone permission denied | iOS Settings → SmartGlasses → Microphone |
| BLE won't connect | Bluetooth off or not paired | iOS Settings → Bluetooth |
| Wake word ignored | Speech recognition permission | iOS Settings → SmartGlasses → Speech Recognition |
| TTS silent | iOS volume or silent mode | Check device volume |
