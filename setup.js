const fs = require('fs');
const path = require('path');

const files = {
  // --- CONFIGURATION ---
  'package.json': JSON.stringify({
    name: 'wii-voice-desktop',
    version: '1.0.0',
    description: 'Peer-to-peer offline LAN voice calling & meetings',
    main: 'dist-electron/main/index.js',
    scripts: {
      dev: 'vite',
      build: 'tsc && vite build && electron-builder',
      'build:electron': 'tsc -p tsconfig.node.json'
    },
    dependencies: {
      'bonjour-service': '^1.3.0',
      'ws': '^8.18.0',
      'uuid': '^11.0.5'
    },
    devDependencies: {
      '@types/node': '^22.13.0',
      '@types/react': '^19.0.8',
      '@types/react-dom': '^19.0.3',
      '@types/ws': '^8.5.14',
      '@types/uuid': '^10.0.0',
      '@vitejs/plugin-react': '^4.3.4',
      'electron': '^34.1.0',
      'electron-builder': '^25.1.8',
      'react': '^19.0.0',
      'react-dom': '^19.0.0',
      'typescript': '^5.7.3',
      'vite': '^6.1.0',
      'vite-plugin-electron': '^0.29.0',
      'vite-plugin-electron-renderer': '^0.14.6'
    }
  }, null, 2),

  'tsconfig.json': JSON.stringify({
    compilerOptions: {
      target: 'ES2022',
      useDefineForClassFields: true,
      lib: ['ES2022', 'DOM', 'DOM.Iterable'],
      module: 'ESNext',
      skipLibCheck: true,
      moduleResolution: 'bundler',
      allowImportingTsExtensions: true,
      resolveJsonModule: true,
      isolatedModules: true,
      noEmit: true,
      jsx: 'react-jsx',
      strict: true,
      noUnusedLocals: true,
      noUnusedParameters: true,
      noFallthroughCasesInSwitch: true
    },
    include: ['src/renderer', 'src/protocol']
  }, null, 2),

  'tsconfig.node.json': JSON.stringify({
    compilerOptions: {
      composite: true,
      skipLibCheck: true,
      module: 'ESNext',
      moduleResolution: 'bundler',
      allowSyntheticDefaultImports: true,
      strict: true
    },
    include: ['src/main', 'src/preload', 'src/protocol', 'vite.config.ts']
  }, null, 2),

  'vite.config.ts': `import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import electron from 'vite-plugin-electron';
import renderer from 'vite-plugin-electron-renderer';
import { resolve } from 'path';

export default defineConfig({
  plugins: [
    react(),
    electron([
      {
        entry: 'src/main/index.ts',
        vite: {
          build: {
            outDir: 'dist-electron/main',
            rollupOptions: {
              external: ['bonjour-service', 'ws']
            }
          }
        }
      },
      {
        entry: 'src/preload/index.ts',
        vite: {
          build: {
            outDir: 'dist-electron/preload'
          }
        }
      }
    ]),
    renderer()
  ],
  resolve: {
    alias: {
      '@protocol': resolve(__dirname, 'src/protocol')
    }
  }
});
`,

  'electron-builder.yml': `appId: com.wiivoice.desktop
productName: WiiVoice
directories:
  output: release
files:
  - dist
  - dist-electron
linux:
  target:
    - AppImage
    - deb
  category: Network
mac:
  target:
    - dmg
  category: public.app-category.utilities
win:
  target:
    - nsis
`,

  // --- PROTOCOL ---
  'src/protocol/types.ts': `export const PROTOCOL_VERSION = '1.0.0';
export const MDNS_SERVICE_NAME = 'wii-voice';

export type ClientPlatform = 'desktop' | 'mobile';

export interface PeerInfo {
  deviceId: string;
  deviceName: string;
  platform: ClientPlatform;
  isPluggedIn: boolean;
  lanIp: string;
  signalingPort: number;
  joinedAt: number;
}

export interface DiscoveredRoom {
  roomId: string;
  roomName: string;
  hostName: string;
  hostIp: string;
  hostPort: number;
  epoch: number;
}

export type SignalingMessage =
  | { type: 'JOIN_REQUEST'; peer: PeerInfo }
  | { type: 'ROOM_STATE'; hostId: string; epoch: number; peers: PeerInfo[] }
  | { type: 'SDP_OFFER'; from: string; to: string; sdp: string }
  | { type: 'SDP_ANSWER'; from: string; to: string; sdp: string }
  | { type: 'ICE_CANDIDATE'; from: string; to: string; candidate: RTCIceCandidateInit }
  | { type: 'PEER_LEFT'; peerId: string };

export type DataChannelMessage =
  | { type: 'PING' }
  | { type: 'PONG' }
  | { type: 'PEER_MUTED'; peerId: string; isMuted: boolean }
  | { type: 'HOST_FAILOVER'; newHostId: string; epoch: number };
`,

  'src/protocol/election.ts': `import { PeerInfo } from './types.ts';

export function electLeader(peers: PeerInfo[]): PeerInfo {
  if (peers.length === 0) throw new Error('Cannot elect leader from empty peer list');

  return [...peers].sort((a, b) => {
    const scoreA = (a.platform === 'desktop' ? 1000 : 100) + (a.isPluggedIn ? 500 : 0) - a.joinedAt;
    const scoreB = (b.platform === 'desktop' ? 1000 : 100) + (b.isPluggedIn ? 500 : 0) - b.joinedAt;

    if (scoreA !== scoreB) return scoreB - scoreA;
    return a.deviceId.localeCompare(b.deviceId);
  })[0];
}
`,

  // --- MAIN PROCESS ---
  'src/main/network.ts': `import os from 'os';

export function getLocalIPv4(): string {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name] || []) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return '127.0.0.1';
}
`,

  'src/main/signaling-server.ts': `import { WebSocketServer, WebSocket } from 'ws';
import { PeerInfo, SignalingMessage } from '../protocol/types.ts';

interface ClientSocket {
  ws: WebSocket;
  peerInfo?: PeerInfo;
}

export class SignalingServer {
  private wss: WebSocketServer | null = null;
  private clients = new Set<ClientSocket>();
  private hostInfo: PeerInfo;
  private epoch = 1;

  constructor(hostInfo: PeerInfo) {
    this.hostInfo = hostInfo;
  }

  public start(port: number): Promise<number> {
    return new Promise((resolve, reject) => {
      this.wss = new WebSocketServer({ port }, () => {
        const boundPort = (this.wss!.address() as any).port;
        this.bindEvents();
        resolve(boundPort);
      });
      this.wss.on('error', reject);
    });
  }

  private bindEvents() {
    if (!this.wss) return;

    this.wss.on('connection', (ws: WebSocket) => {
      const client: ClientSocket = { ws };
      this.clients.add(client);

      ws.on('message', (raw: string) => {
        try {
          const msg: SignalingMessage = JSON.parse(raw);
          this.handleMessage(client, msg);
        } catch (err) {
          console.error('[SignalingServer] Parse error:', err);
        }
      });

      ws.on('close', () => {
        this.clients.delete(client);
        if (client.peerInfo) {
          this.broadcast({ type: 'PEER_LEFT', peerId: client.peerInfo.deviceId });
          this.broadcastRoomState();
        }
      });
    });
  }

  private handleMessage(client: ClientSocket, msg: SignalingMessage) {
    switch (msg.type) {
      case 'JOIN_REQUEST': {
        client.peerInfo = msg.peer;
        this.broadcastRoomState();
        break;
      }
      case 'SDP_OFFER':
      case 'SDP_ANSWER':
      case 'ICE_CANDIDATE': {
        this.forwardTargeted(msg.to, msg);
        break;
      }
    }
  }

  private forwardTargeted(targetDeviceId: string, msg: SignalingMessage) {
    for (const client of this.clients) {
      if (client.peerInfo?.deviceId === targetDeviceId && client.ws.readyState === WebSocket.OPEN) {
        client.ws.send(JSON.stringify(msg));
        break;
      }
    }
  }

  public broadcast(msg: SignalingMessage) {
    const raw = JSON.stringify(msg);
    for (const client of this.clients) {
      if (client.ws.readyState === WebSocket.OPEN) {
        client.ws.send(raw);
      }
    }
  }

  public broadcastRoomState() {
    const peers: PeerInfo[] = [this.hostInfo];
    for (const client of this.clients) {
      if (client.peerInfo) peers.push(client.peerInfo);
    }

    const stateMsg: SignalingMessage = {
      type: 'ROOM_STATE',
      hostId: this.hostInfo.deviceId,
      epoch: this.epoch,
      peers
    };

    this.broadcast(stateMsg);
  }

  public stop() {
    if (this.wss) {
      this.wss.close();
      this.wss = null;
      this.clients.clear();
    }
  }
}
`,

  'src/main/discovery.ts': `import { Bonjour, Service } from 'bonjour-service';
import { DiscoveredRoom, MDNS_SERVICE_NAME } from '../protocol/types.ts';

export class DiscoveryManager {
  private bonjour = new Bonjour();
  private publishedService: Service | null = null;
  private onRoomFoundCallback: (rooms: DiscoveredRoom[]) => void;
  private discoveredMap = new Map<string, DiscoveredRoom>();

  constructor(onRoomFound: (rooms: DiscoveredRoom[]) => void) {
    this.onRoomFoundCallback = onRoomFound;
  }

  public startAdvertising(room: DiscoveredRoom) {
    this.stopAdvertising();
    this.publishedService = this.bonjour.publish({
      name: \`\${room.roomName}_\${room.roomId.substring(0, 6)}\`,
      type: MDNS_SERVICE_NAME,
      port: room.hostPort,
      txt: {
        roomId: room.roomId,
        roomName: room.roomName,
        hostName: room.hostName,
        epoch: room.epoch.toString()
      }
    });
  }

  public stopAdvertising() {
    if (this.publishedService) {
      this.bonjour.unpublishAll();
      this.publishedService = null;
    }
  }

  public startBrowsing() {
    this.discoveredMap.clear();
    this.bonjour.find({ type: MDNS_SERVICE_NAME }, (service: any) => {
      if (!service.txt || !service.addresses) return;
      const ipv4 = service.addresses.find((addr: string) => addr.includes('.')) || service.referer?.address;
      if (!ipv4) return;

      const room: DiscoveredRoom = {
        roomId: service.txt.roomId,
        roomName: service.txt.roomName,
        hostName: service.txt.hostName,
        hostIp: ipv4,
        hostPort: service.port,
        epoch: parseInt(service.txt.epoch || '1', 10)
      };

      this.discoveredMap.set(room.roomId, room);
      this.onRoomFoundCallback(Array.from(this.discoveredMap.values()));
    });
  }

  public stopBrowsing() {
    this.bonjour.destroy();
  }
}
`,

  'src/main/ipc.ts': `import { ipcMain, powerMonitor, BrowserWindow } from 'electron';
import { SignalingServer } from './signaling-server.ts';
import { DiscoveryManager } from './discovery.ts';
import { getLocalIPv4 } from './network.ts';
import { DiscoveredRoom, PeerInfo } from '../protocol/types.ts';

export function setupIpc(win: BrowserWindow) {
  let server: SignalingServer | null = null;
  const discovery = new DiscoveryManager((rooms) => {
    win.webContents.send('rooms-updated', rooms);
  });

  discovery.startBrowsing();

  ipcMain.handle('get-local-ip', () => getLocalIPv4());
  
  ipcMain.handle('is-plugged-in', () => !powerMonitor.isOnBatteryPower());

  ipcMain.handle('start-hosting', async (_, { roomName, hostInfo }: { roomName: string; hostInfo: PeerInfo }) => {
    if (server) server.stop();

    server = new SignalingServer(hostInfo);
    const boundPort = await server.start(0);

    const room: DiscoveredRoom = {
      roomId: hostInfo.deviceId,
      roomName,
      hostName: hostInfo.deviceName,
      hostIp: hostInfo.lanIp,
      hostPort: boundPort,
      epoch: 1
    };

    discovery.startAdvertising(room);
    return { port: boundPort };
  });

  ipcMain.handle('stop-hosting', async () => {
    if (server) {
      server.stop();
      server = null;
    }
    discovery.stopAdvertising();
  });
}
`,

  'src/main/index.ts': `import { app, BrowserWindow } from 'electron';
import path from 'path';
import { setupIpc } from './ipc.ts';

let mainWindow: BrowserWindow | null = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1024,
    height: 720,
    minWidth: 800,
    minHeight: 600,
    backgroundColor: '#0f172a',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true
    }
  });

  setupIpc(mainWindow);

  if (process.env.VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else {
    mainWindow.loadFile(path.join(__dirname, '../../dist/index.html'));
  }
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
`,

  // --- PRELOAD ---
  'src/preload/index.ts': `import { contextBridge, ipcRenderer } from 'electron';
import { DiscoveredRoom, PeerInfo } from '../protocol/types.ts';

export const voiceAPI = {
  getLocalIp: (): Promise<string> => ipcRenderer.invoke('get-local-ip'),
  isPluggedIn: (): Promise<boolean> => ipcRenderer.invoke('is-plugged-in'),
  startHosting: (params: { roomName: string; hostInfo: PeerInfo }): Promise<{ port: number }> =>
    ipcRenderer.invoke('start-hosting', params),
  stopHosting: (): Promise<void> => ipcRenderer.invoke('stop-hosting'),
  onRoomsUpdated: (callback: (rooms: DiscoveredRoom[]) => void) => {
    const handler = (_: any, rooms: DiscoveredRoom[]) => callback(rooms);
    ipcRenderer.on('rooms-updated', handler);
    return () => ipcRenderer.removeListener('rooms-updated', handler);
  }
};

contextBridge.exposeInMainWorld('voiceAPI', voiceAPI);
`,

  'src/preload/types.d.ts': `import { voiceAPI } from './index.ts';

declare global {
  interface Window {
    voiceAPI: typeof voiceAPI;
  }
}
export {};
`,

  // --- RENDERER PROCESS ---
  'src/renderer/index.html': `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Wii Voice</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
`,

  'src/renderer/src/styles.css': `* {
  box-sizing: border-box;
  margin: 0;
  padding: 0;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
}

body {
  background-color: #0b0f19;
  color: #f8fafc;
  overflow: hidden;
  user-select: none;
}

.app-container {
  display: flex;
  height: 100vh;
  width: 100vw;
}

.sidebar {
  width: 320px;
  background-color: #111827;
  border-right: 1px solid #1f2937;
  display: flex;
  flex-direction: column;
  padding: 20px;
  gap: 20px;
}

.content {
  flex: 1;
  background-color: #0b0f19;
  display: flex;
  flex-direction: column;
  padding: 24px;
  overflow-y: auto;
}

.panel-header {
  font-size: 1.1rem;
  font-weight: 700;
  letter-spacing: -0.02em;
  color: #94a3b8;
  text-transform: uppercase;
  font-size: 0.75rem;
  margin-bottom: 8px;
}

.card {
  background: #1e293b;
  border: 1px solid #334155;
  border-radius: 8px;
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

input[type="text"] {
  background: #0f172a;
  border: 1px solid #334155;
  border-radius: 6px;
  color: #fff;
  padding: 8px 12px;
  outline: none;
  font-size: 0.9rem;
}

input[type="text"]:focus {
  border-color: #38bdf8;
}

button {
  background: #2563eb;
  color: white;
  border: none;
  border-radius: 6px;
  padding: 10px 16px;
  font-weight: 600;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  transition: all 0.2s;
}

button:hover {
  background: #1d4ed8;
}

button.danger {
  background: #dc2626;
}

button.danger:hover {
  background: #b91c1c;
}

button.secondary {
  background: #334155;
}

button.secondary:hover {
  background: #475569;
}

.room-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  overflow-y: auto;
  max-height: 250px;
}

.room-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px;
  background: #0f172a;
  border: 1px solid #1e293b;
  border-radius: 6px;
}

.grid-peers {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: 16px;
  margin-top: 20px;
}

.peer-card {
  background: #1e293b;
  border: 2px solid #334155;
  border-radius: 10px;
  height: 160px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  position: relative;
  gap: 10px;
}

.peer-card.speaking {
  border-color: #22c55e;
  box-shadow: 0 0 12px rgba(34, 197, 94, 0.4);
}

.avatar {
  width: 56px;
  height: 56px;
  background: #334155;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-weight: bold;
  font-size: 1.25rem;
}

.badge {
  font-size: 0.65rem;
  padding: 2px 6px;
  border-radius: 4px;
  background: #475569;
  text-transform: uppercase;
}

.badge.host {
  background: #eab308;
  color: #000;
  font-weight: 700;
}

.control-bar {
  margin-top: auto;
  background: #1e293b;
  border-radius: 12px;
  padding: 12px 24px;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 16px;
}
`,

  'src/renderer/src/webrtc/AudioEngine.ts': `export class AudioEngine {
  private localStream: MediaStream | null = null;
  private audioElements = new Map<string, HTMLAudioElement>();

  public async getLocalStream(): Promise<MediaStream> {
    if (!this.localStream) {
      this.localStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        },
        video: false
      });
    }
    return this.localStream;
  }

  public setMicrophoneMute(isMuted: boolean) {
    if (this.localStream) {
      this.localStream.getAudioTracks().forEach(track => {
        track.enabled = !isMuted;
      });
    }
  }

  public attachRemoteStream(peerId: string, stream: MediaStream) {
    let audio = this.audioElements.get(peerId);
    if (!audio) {
      audio = document.createElement('audio');
      audio.autoplay = true;
      (audio as any).playsInline = true;
      this.audioElements.set(peerId, audio);
      document.body.appendChild(audio);
    }
    audio.srcObject = stream;
    audio.play().catch(console.error);
  }

  public detachRemoteStream(peerId: string) {
    const audio = this.audioElements.get(peerId);
    if (audio) {
      audio.srcObject = null;
      audio.remove();
      this.audioElements.delete(peerId);
    }
  }

  public cleanup() {
    if (this.localStream) {
      this.localStream.getTracks().forEach(t => t.stop());
      this.localStream = null;
    }
    this.audioElements.forEach(audio => {
      audio.srcObject = null;
      audio.remove();
    });
    this.audioElements.clear();
  }
}
`,

  'src/renderer/src/webrtc/MeshCoordinator.ts': `import { PeerInfo, SignalingMessage, DataChannelMessage } from '../../../protocol/types.ts';

export interface PeerNode {
  info: PeerInfo;
  pc: RTCPeerConnection;
  channel: RTCDataChannel | null;
  makingOffer: boolean;
  ignoreOffer: boolean;
  isPolite: boolean;
  iceQueue: RTCIceCandidateInit[];
  missedPings: number;
}

export class MeshCoordinator {
  private peers = new Map<string, PeerNode>();
  private localStream: MediaStream | null = null;
  private localInfo: PeerInfo;
  private sendSignaling: (msg: SignalingMessage) => void;
  private onRemoteStream: (peerId: string, stream: MediaStream) => void;
  private onPeerDropped: (peerId: string) => void;

  constructor(
    localInfo: PeerInfo,
    sendSignaling: (msg: SignalingMessage) => void,
    onRemoteStream: (peerId: string, stream: MediaStream) => void,
    onPeerDropped: (peerId: string) => void
  ) {
    this.localInfo = localInfo;
    this.sendSignaling = sendSignaling;
    this.onRemoteStream = onRemoteStream;
    this.onPeerDropped = onPeerDropped;
  }

  public setLocalStream(stream: MediaStream) {
    this.localStream = stream;
    this.peers.forEach(peer => {
      this.localStream?.getAudioTracks().forEach(t => peer.pc.addTrack(t, this.localStream!));
    });
  }

  public addPeer(info: PeerInfo, initiateOffer: boolean) {
    if (this.peers.has(info.deviceId)) return;

    const pc = new RTCPeerConnection({ iceServers: [] });
    const isPolite = this.localInfo.deviceId.localeCompare(info.deviceId) > 0;

    const node: PeerNode = {
      info,
      pc,
      channel: null,
      makingOffer: false,
      ignoreOffer: false,
      isPolite,
      iceQueue: [],
      missedPings: 0
    };

    this.peers.set(info.deviceId, node);
    this.bindConnection(node, initiateOffer);
  }

  private bindConnection(node: PeerNode, initiateOffer: boolean) {
    const { pc, info } = node;

    if (this.localStream) {
      this.localStream.getAudioTracks().forEach(t => pc.addTrack(t, this.localStream!));
    }

    pc.ontrack = (evt) => {
      if (evt.streams && evt.streams[0]) {
        this.onRemoteStream(info.deviceId, evt.streams[0]);
      }
    };

    pc.onicecandidate = (evt) => {
      if (evt.candidate) {
        this.sendSignaling({
          type: 'ICE_CANDIDATE',
          from: this.localInfo.deviceId,
          to: info.deviceId,
          candidate: evt.candidate.toJSON()
        });
      }
    };

    if (initiateOffer) {
      const channel = pc.createDataChannel('meeting-control');
      this.setupDataChannel(node, channel);
    } else {
      pc.ondatachannel = (evt) => this.setupDataChannel(node, evt.channel);
    }

    pc.onnegotiationneeded = async () => {
      try {
        node.makingOffer = true;
        await pc.setLocalDescription();
        this.sendSignaling({
          type: 'SDP_OFFER',
          from: this.localInfo.deviceId,
          to: info.deviceId,
          sdp: pc.localDescription!.sdp
        });
      } catch (err) {
        console.error('Negotiation error:', err);
      } finally {
        node.makingOffer = false;
      }
    };
  }

  private setupDataChannel(node: PeerNode, channel: RTCDataChannel) {
    node.channel = channel;
    channel.onmessage = (evt) => {
      const msg: DataChannelMessage = JSON.parse(evt.data);
      if (msg.type === 'PING') {
        channel.send(JSON.stringify({ type: 'PONG' }));
      } else if (msg.type === 'PONG') {
        node.missedPings = 0;
      }
    };
  }

  public async handleOffer(fromId: string, sdp: string) {
    const node = this.peers.get(fromId);
    if (!node) return;

    const offerCollision = node.makingOffer || node.pc.signalingState !== 'stable';
    node.ignoreOffer = !node.isPolite && offerCollision;
    if (node.ignoreOffer) return;

    if (offerCollision && node.isPolite) {
      await node.pc.setLocalDescription({ type: 'rollback' });
    }

    await node.pc.setRemoteDescription({ type: 'offer', sdp });

    for (const c of node.iceQueue) {
      await node.pc.addIceCandidate(c);
    }
    node.iceQueue = [];

    await node.pc.setLocalDescription();
    this.sendSignaling({
      type: 'SDP_ANSWER',
      from: this.localInfo.deviceId,
      to: fromId,
      sdp: node.pc.localDescription!.sdp
    });
  }

  public async handleAnswer(fromId: string, sdp: string) {
    const node = this.peers.get(fromId);
    if (!node || node.ignoreOffer) return;
    await node.pc.setRemoteDescription({ type: 'answer', sdp });
  }

  public async handleCandidate(fromId: string, candidate: RTCIceCandidateInit) {
    const node = this.peers.get(fromId);
    if (!node) return;

    if (node.pc.remoteDescription?.type) {
      await node.pc.addIceCandidate(candidate);
    } else {
      node.iceQueue.push(candidate);
    }
  }

  public dropPeer(peerId: string) {
    const node = this.peers.get(peerId);
    if (!node) return;

    node.channel?.close();
    node.pc.close();
    this.peers.delete(peerId);
    this.onPeerDropped(peerId);
  }

  public pingTick() {
    this.peers.forEach((node, peerId) => {
      if (node.channel?.readyState === 'open') {
        node.missedPings++;
        if (node.missedPings >= 3) {
          this.dropPeer(peerId);
        } else {
          node.channel.send(JSON.stringify({ type: 'PING' }));
        }
      }
    });
  }

  public cleanup() {
    this.peers.forEach(node => {
      node.channel?.close();
      node.pc.close();
    });
    this.peers.clear();
  }
}
`,

  'src/renderer/src/App.tsx': `import React, { useState, useEffect, useRef } from 'react';
import { v4 as uuidv4 } from 'uuid';
import { PeerInfo, DiscoveredRoom, SignalingMessage } from '../../protocol/types.ts';
import { AudioEngine } from './webrtc/AudioEngine.ts';
import { MeshCoordinator } from './webrtc/MeshCoordinator.ts';

const myDeviceId = uuidv4();

export default function App() {
  const [localIp, setLocalIp] = useState<string>('127.0.0.1');
  const [isPluggedIn, setIsPluggedIn] = useState<boolean>(true);
  const [roomNameInput, setRoomNameInput] = useState('');
  const [availableRooms, setAvailableRooms] = useState<DiscoveredRoom[]>([]);
  const [activeRoom, setActiveRoom] = useState<DiscoveredRoom | null>(null);
  const [participants, setParticipants] = useState<PeerInfo[]>([]);
  const [isMuted, setIsMuted] = useState(false);

  const socketRef = useRef<WebSocket | null>(null);
  const audioEngineRef = useRef<AudioEngine>(new AudioEngine());
  const meshRef = useRef<MeshCoordinator | null>(null);

  const localInfo: PeerInfo = {
    deviceId: myDeviceId,
    deviceName: \`Desktop-\${myDeviceId.slice(0, 4)}\`,
    platform: 'desktop',
    isPluggedIn,
    lanIp: localIp,
    signalingPort: 0,
    joinedAt: Date.now()
  };

  useEffect(() => {
    window.voiceAPI.getLocalIp().then(setLocalIp);
    window.voiceAPI.isPluggedIn().then(setIsPluggedIn);
    const unbind = window.voiceAPI.onRoomsUpdated(setAvailableRooms);
    return () => unbind();
  }, []);

  const sendSignaling = (msg: SignalingMessage) => {
    if (socketRef.current?.readyState === WebSocket.OPEN) {
      socketRef.current.send(JSON.stringify(msg));
    }
  };

  const startMeeting = async () => {
    if (!roomNameInput.trim()) return;
    const { port } = await window.voiceAPI.startHosting({ roomName: roomNameInput, hostInfo: localInfo });

    const room: DiscoveredRoom = {
      roomId: localInfo.deviceId,
      roomName: roomNameInput,
      hostName: localInfo.deviceName,
      hostIp: localInfo.lanIp,
      hostPort: port,
      epoch: 1
    };

    setActiveRoom(room);
    joinSocketServer(room.hostIp, room.hostPort);
  };

  const joinMeeting = (room: DiscoveredRoom) => {
    setActiveRoom(room);
    joinSocketServer(room.hostIp, room.hostPort);
  };

  const joinSocketServer = async (ip: string, port: number) => {
    const stream = await audioEngineRef.current.getLocalStream();
    meshRef.current = new MeshCoordinator(
      localInfo,
      sendSignaling,
      (peerId, remoteStream) => audioEngineRef.current.attachRemoteStream(peerId, remoteStream),
      (peerId) => audioEngineRef.current.detachRemoteStream(peerId)
    );
    meshRef.current.setLocalStream(stream);

    const ws = new WebSocket(\`ws://\${ip}:\${port}\`);
    socketRef.current = ws;

    ws.onopen = () => {
      sendSignaling({ type: 'JOIN_REQUEST', peer: localInfo });
    };

    ws.onmessage = async (evt) => {
      const msg: SignalingMessage = JSON.parse(evt.data);
      switch (msg.type) {
        case 'ROOM_STATE': {
          setParticipants(msg.peers);
          msg.peers.forEach(peer => {
            if (peer.deviceId !== localInfo.deviceId) {
              const shouldOffer = localInfo.deviceId > peer.deviceId;
              meshRef.current?.addPeer(peer, shouldOffer);
            }
          });
          break;
        }
        case 'SDP_OFFER':
          await meshRef.current?.handleOffer(msg.from, msg.sdp);
          break;
        case 'SDP_ANSWER':
          await meshRef.current?.handleAnswer(msg.from, msg.sdp);
          break;
        case 'ICE_CANDIDATE':
          await meshRef.current?.handleCandidate(msg.from, msg.candidate);
          break;
        case 'PEER_LEFT':
          meshRef.current?.dropPeer(msg.peerId);
          setParticipants(prev => prev.filter(p => p.deviceId !== msg.peerId));
          break;
      }
    };
  };

  const leaveMeeting = async () => {
    socketRef.current?.close();
    meshRef.current?.cleanup();
    audioEngineRef.current.cleanup();
    await window.voiceAPI.stopHosting();
    setActiveRoom(null);
    setParticipants([]);
  };

  const toggleMute = () => {
    const next = !isMuted;
    setIsMuted(next);
    audioEngineRef.current.setMicrophoneMute(next);
  };

  return (
    <div className="app-container">
      <div className="sidebar">
        <div>
          <div className="panel-header">Local Node Identity</div>
          <div className="card">
            <div><strong>IP:</strong> {localIp}</div>
            <div><strong>Power:</strong> {isPluggedIn ? '⚡ AC Power' : '🔋 Battery'}</div>
            <div><strong>ID:</strong> {localInfo.deviceName}</div>
          </div>
        </div>

        {!activeRoom && (
          <div>
            <div className="panel-header">Host a New Meeting</div>
            <div className="card">
              <input
                type="text"
                placeholder="Meeting Name..."
                value={roomNameInput}
                onChange={e => setRoomNameInput(e.target.value)}
              />
              <button onClick={startMeeting}>Create Room</button>
            </div>
          </div>
        )}

        <div>
          <div className="panel-header">Discovered LAN Meetings</div>
          <div className="room-list">
            {availableRooms.length === 0 && <div style={{ color: '#64748b' }}>No LAN meetings detected...</div>}
            {availableRooms.map(room => (
              <div key={room.roomId} className="room-item">
                <div>
                  <div style={{ fontWeight: 600 }}>{room.roomName}</div>
                  <div style={{ fontSize: '0.75rem', color: '#94a3b8' }}>Host: {room.hostName}</div>
                </div>
                {!activeRoom && (
                  <button className="secondary" onClick={() => joinMeeting(room)}>Join</button>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="content">
        {activeRoom ? (
          <>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div>
                <h2>{activeRoom.roomName}</h2>
                <span style={{ color: '#94a3b8' }}>Mesh connected ({participants.length} peers)</span>
              </div>
              <button className="danger" onClick={leaveMeeting}>Leave Room</button>
            </div>

            <div className="grid-peers">
              {participants.map(peer => (
                <div key={peer.deviceId} className="peer-card">
                  <div className="avatar">{peer.deviceName.slice(0, 2).toUpperCase()}</div>
                  <div style={{ fontWeight: 600 }}>{peer.deviceName}</div>
                  <span className={\`badge \${peer.deviceId === activeRoom.roomId ? 'host' : ''}\`}>
                    {peer.deviceId === activeRoom.roomId ? 'Host' : peer.platform}
                  </span>
                </div>
              ))}
            </div>

            <div className="control-bar">
              <button className={isMuted ? 'danger' : 'secondary'} onClick={toggleMute}>
                {isMuted ? 'Unmute Mic' : 'Mute Mic'}
              </button>
            </div>
          </>
        ) : (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: '#64748b' }}>
            Select an active LAN room on the left or create a new room to begin talking.
          </div>
        )}
      </div>
    </div>
  );
}
`,

  'src/renderer/src/main.tsx': `import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.tsx';
import './styles.css';

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
`
};

console.log('Generating Wii Voice Electron project files...');

Object.entries(files).forEach(([relPath, content]) => {
  const fullPath = path.join(__dirname, relPath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content, 'utf8');
  console.log(`  ✓ ${relPath}`);
});

console.log('\nProject generated successfully!');
console.log('\nNext steps:');
console.log('  1. npm install');
console.log('  2. npm run dev');