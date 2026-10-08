import { contextBridge, ipcRenderer } from 'electron';
import type { DiscoveredRoom, PeerInfo, NetworkInterfaceInfo } from '../protocol/types.ts';

export const voiceAPI = {
  getLocalIp: (): Promise<string> => ipcRenderer.invoke('get-local-ip'),
  getNetworkInterfaces: (): Promise<NetworkInterfaceInfo[]> => ipcRenderer.invoke('get-network-interfaces'),
  isPluggedIn: (): Promise<boolean> => ipcRenderer.invoke('is-plugged-in'),
  startHosting: (params: { roomName: string; hostInfo: PeerInfo; preferredPort?: number; isRoom?: boolean }): Promise<{ port: number }> =>
    ipcRenderer.invoke('start-hosting', params),
  stopHosting: (): Promise<void> => ipcRenderer.invoke('stop-hosting'),
  showIncomingCallNotification: (params: { callerName: string; callerIp: string }): Promise<void> =>
    ipcRenderer.invoke('show-incoming-call-notification', params),
  clearNotificationAttention: (): Promise<void> => ipcRenderer.invoke('clear-notification-attention'),
  focusWindow: (): Promise<void> => ipcRenderer.invoke('focus-window'),
  bringToFront: (): Promise<void> => ipcRenderer.invoke('bring-to-front'),
  getMicrophonePermissionStatus: (): Promise<string> => ipcRenderer.invoke('get-mic-permission'),
  requestMicrophonePermission: (): Promise<string> => ipcRenderer.invoke('request-mic-permission'),
  openSystemMicrophoneSettings: (): Promise<void> => ipcRenderer.invoke('open-system-mic-settings'),
  onRoomsUpdated: (callback: (rooms: DiscoveredRoom[]) => void) => {
    const handler = (_: any, rooms: DiscoveredRoom[]) => callback(rooms);
    ipcRenderer.on('rooms-updated', handler);
    return () => {
      ipcRenderer.removeListener('rooms-updated', handler);
    };
  },
  onIncomingCall: (callback: (data: { caller: PeerInfo; callId: string }) => void) => {
    const handler = (_: any, data: { caller: PeerInfo; callId: string }) => callback(data);
    ipcRenderer.on('incoming-call', handler);
    return () => {
      ipcRenderer.removeListener('incoming-call', handler);
    };
  }
};

contextBridge.exposeInMainWorld('voiceAPI', voiceAPI);

