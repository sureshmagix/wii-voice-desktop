# Wii Voice Desktop

> Peer-to-peer offline LAN voice calling, multi-party rooms, and hardware microphone verification application. Zero internet, zero cloud servers, zero STUN/TURN required.

---

## ✨ Features

- **Offline LAN Direct Voice Calling**: 1-to-1 direct calling by device IP or saved contacts using mDNS discovery and local WebSocket signaling.
- **Landroom Multi-Party Voice Rooms**: Host or join multi-peer WebRTC mesh voice rooms across local networks without external servers.
- **Prominent Incoming Call Notifications**: High-contrast animated call overlay, dock bounce, native OS desktop notifications, and acoustic chime rings.
- **Hardware Microphone Verification**:
  - Test voice clip recording (5s clip with countdown and real-time VU meter).
  - Voice activity detection verifying clear speech versus silence.
  - Audio playback through selected speaker/headphones.
- **Cross-Platform Audio Device Management**:
  - Dynamic input/output device switching during calls.
  - Acoustic Echo Cancellation, Noise Suppression, and Automatic Gain Control with Opus 48 kHz stereo audio.
  - Dedicated macOS entitlements and TCC permission handlers.
- **Address Book & Call History**:
  - Auto-discovery of online LAN nodes.
  - Saved custom contacts and recent call log with duration tracking and 1-click redial.

---

## 🚀 Getting Started

### Prerequisites

- Node.js 18+ (tested on Node 20 & 22)
- npm 9+

### Installation & Development

```bash
# Clone the repository
git clone https://github.com/sureshmagix/wii-voice-desktop.git
cd wii-voice-desktop

# Install dependencies
npm install

# Start development mode
npm run dev
```

### Packaging & Distribution

```bash
# Compile and build application bundles
npm run build:app

# Build for macOS (Universal / x64 DMG & arm64 DMG)
npm run build:mac

# Build for Windows (NSIS Installer)
npm run build:win

# Build for Linux (AppImage, deb, tar.gz)
npm run build:linux

# Build all targets
npm run build:all
```

---

## 📁 Project Architecture

- `src/main/`: Electron main process (lifecycle, IPC, mDNS Bonjour discovery, WebSocket signaling server, macOS media permissions).
- `src/preload/`: Secure contextBridge API (`voiceAPI`).
- `src/renderer/`: React + Vite user interface (Direct dial, contacts, Landroom mesh coordinator, Web Audio VU meters, voice recorder).
- `src/protocol/`: Signaling protocol types and message contracts.
- `build/`: macOS entitlements and helper plists.

---

## 📄 License

MIT License.
