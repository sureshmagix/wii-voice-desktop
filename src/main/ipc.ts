import { ipcMain, powerMonitor, BrowserWindow, Notification, app } from 'electron';
import { SignalingServer } from './signaling-server.ts';
import { DiscoveryManager } from './discovery.ts';
import { getLocalIPv4, getAllIPv4Interfaces } from './network.ts';
import type { DiscoveredRoom, PeerInfo } from '../protocol/types.ts';

let currentWindow: BrowserWindow | null = null;
let server: SignalingServer | null = null;
let discovery: DiscoveryManager | null = null;
let isInitialized = false;

function notifyIncomingCall(callerName: string, callerIp: string) {
  if (currentWindow && !currentWindow.isDestroyed()) {
    if (currentWindow.isMinimized()) currentWindow.restore();
    currentWindow.show();
    currentWindow.focus();
    currentWindow.flashFrame(true);
    if (process.platform === 'darwin') {
      if (app.dock) app.dock.bounce('critical');
      app.focus({ steal: true });
    }
  }

  if (Notification.isSupported()) {
    try {
      const notification = new Notification({
        title: 'Incoming Voice Call',
        body: `${callerName} (${callerIp}) is calling. Click to answer.`,
        urgency: 'critical',
        silent: false
      });
      notification.on('click', () => {
        if (currentWindow && !currentWindow.isDestroyed()) {
          if (currentWindow.isMinimized()) currentWindow.restore();
          currentWindow.show();
          currentWindow.focus();
          if (process.platform === 'darwin') {
            app.focus({ steal: true });
          }
        }
      });
      notification.show();
    } catch (err) {
      console.warn('System notification error:', err);
    }
  }
}

function clearCallAttention() {
  if (currentWindow && !currentWindow.isDestroyed()) {
    currentWindow.flashFrame(false);
  }
}

export function setupIpc(win: BrowserWindow) {
  currentWindow = win;
  if (isInitialized) return;

  isInitialized = true;
  discovery = new DiscoveryManager((rooms) => {
    if (currentWindow && !currentWindow.isDestroyed()) {
      currentWindow.webContents.send('rooms-updated', rooms);
    }
  });

  discovery.startBrowsing();

  ipcMain.handle('get-local-ip', () => getLocalIPv4());
  ipcMain.handle('get-network-interfaces', () => getAllIPv4Interfaces());
  
  ipcMain.handle('is-plugged-in', () => !powerMonitor.isOnBatteryPower());

  ipcMain.handle('start-hosting', async (_, { roomName, hostInfo, preferredPort, isRoom }: { roomName: string; hostInfo: PeerInfo; preferredPort?: number; isRoom?: boolean }) => {
    const normalizedRoomName = roomName.trim() || 'Direct Voice Call';

    if (server) server.stop();
    discovery?.stopAdvertising();

    server = new SignalingServer(hostInfo, (caller, callId) => {
      notifyIncomingCall(caller.deviceName, caller.lanIp);
      if (currentWindow && !currentWindow.isDestroyed()) {
        currentWindow.webContents.send('incoming-call', { caller, callId });
      }
    });

    const targetPort = preferredPort && preferredPort > 0 ? preferredPort : 5252;
    const boundPort = await server.start(targetPort);

    const room: DiscoveredRoom = {
      roomId: hostInfo.deviceId,
      roomName: normalizedRoomName,
      hostName: hostInfo.deviceName,
      hostIp: hostInfo.lanIp,
      hostPort: boundPort,
      epoch: 1,
      isRoom: !!isRoom
    };

    discovery?.startAdvertising(room);
    return { port: boundPort };
  });

  ipcMain.handle('stop-hosting', async () => {
    if (server) {
      server.stop();
      server = null;
    }
    discovery?.stopAdvertising();
  });

  ipcMain.handle('show-incoming-call-notification', (_, { callerName, callerIp }: { callerName: string; callerIp: string }) => {
    notifyIncomingCall(callerName, callerIp);
  });

  ipcMain.handle('clear-notification-attention', () => {
    clearCallAttention();
  });

  ipcMain.handle('focus-window', () => {
    if (currentWindow && !currentWindow.isDestroyed()) {
      if (currentWindow.isMinimized()) currentWindow.restore();
      currentWindow.show();
      currentWindow.focus();
    }
  });

  ipcMain.handle('bring-to-front', () => {
    if (currentWindow && !currentWindow.isDestroyed()) {
      if (currentWindow.isMinimized()) currentWindow.restore();
      currentWindow.show();
      currentWindow.focus();
      if (process.platform === 'darwin') {
        app.focus({ steal: true });
      }
    }
  });

  ipcMain.handle('get-mic-permission', async () => {
    if (process.platform === 'darwin') {
      try {
        const { systemPreferences } = await import('electron');
        return systemPreferences.getMediaAccessStatus('microphone');
      } catch {
        return 'granted';
      }
    }
    return 'granted';
  });

  ipcMain.handle('request-mic-permission', async () => {
    if (process.platform === 'darwin') {
      try {
        const { systemPreferences } = await import('electron');
        const status = systemPreferences.getMediaAccessStatus('microphone');
        if (status === 'not-determined') {
          const granted = await systemPreferences.askForMediaAccess('microphone');
          return granted ? 'granted' : 'denied';
        }
        return status;
      } catch {
        return 'granted';
      }
    }
    return 'granted';
  });

  ipcMain.handle('open-system-mic-settings', async () => {
    if (process.platform === 'darwin') {
      try {
        const { shell } = await import('electron');
        await shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone');
      } catch (err) {
        console.warn('Could not open macOS privacy settings:', err);
      }
    } else if (process.platform === 'win32') {
      try {
        const { shell } = await import('electron');
        await shell.openExternal('ms-settings:privacy-microphone');
      } catch {}
    }
  });
}

export function shutdownIpc() {
  server?.stop();
  server = null;
  discovery?.stopAdvertising();
  discovery?.stopBrowsing();
  discovery = null;
  currentWindow = null;

  if (isInitialized) {
    ipcMain.removeHandler('get-local-ip');
    ipcMain.removeHandler('get-network-interfaces');
    ipcMain.removeHandler('is-plugged-in');
    ipcMain.removeHandler('start-hosting');
    ipcMain.removeHandler('stop-hosting');
    ipcMain.removeHandler('show-incoming-call-notification');
    ipcMain.removeHandler('clear-notification-attention');
    ipcMain.removeHandler('focus-window');
    ipcMain.removeHandler('bring-to-front');
    ipcMain.removeHandler('get-mic-permission');
    ipcMain.removeHandler('request-mic-permission');
    ipcMain.removeHandler('open-system-mic-settings');
    isInitialized = false;
  }
}
