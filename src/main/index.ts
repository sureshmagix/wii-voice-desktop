import { app, BrowserWindow, session, systemPreferences } from 'electron';
import path from 'path';
import { setupIpc, shutdownIpc } from './ipc.ts';

// Enable WebRTC offline LAN IP discovery by disabling mDNS IP hiding
app.commandLine.appendSwitch('disable-features', 'WebRtcHideLocalIpsWithMdns');
// Allow audio playback (ringtones, test chimes) without preliminary click
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

if (process.platform === 'win32') {
  app.setAppUserModelId('com.wiivoice.desktop');
}

let mainWindow: BrowserWindow | null = null;

function createWindow() {
  // Explicitly handle and allow media (microphone) permissions
  // Explicitly handle and allow media (microphone) permissions
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback, details: any) => {
    if (permission === 'media' || permission === 'notifications') {
      callback(true);
    } else if (details?.mediaType === 'audio' || details?.mediaTypes?.includes('audio')) {
      callback(true);
    } else {
      callback(true);
    }
  });

  session.defaultSession.setPermissionCheckHandler((_webContents, permission, _origin, details) => {
    if (permission === 'media' || permission === 'notifications') {
      return true;
    }
    if (details?.mediaType === 'audio') {
      return true;
    }
    return true;
  });

  session.defaultSession.setDevicePermissionHandler(() => true);

  mainWindow = new BrowserWindow({
    width: 1024,
    height: 720,
    minWidth: 800,
    minHeight: 600,
    backgroundColor: '#0f172a',
    icon: path.join(__dirname, '../../build/icon.png'),
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

app.whenReady().then(async () => {
  if (process.platform === 'darwin') {
    try {
      const status = systemPreferences.getMediaAccessStatus('microphone');
      if (status === 'not-determined') {
        await systemPreferences.askForMediaAccess('microphone');
      }
    } catch (err) {
      console.warn('macOS mic permission probe error:', err);
    }
  }
  createWindow();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', shutdownIpc);
