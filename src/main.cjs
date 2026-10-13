'use strict';

const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { isTrustedSender: validateSender } = require('./sender-policy.cjs');
const {
  app,
  BrowserWindow,
  Menu,
  ipcMain,
  powerSaveBlocker,
  session,
  shell,
} = require('electron');
const { probeMedia } = require('./media-probe.cjs');

// Prefer the discrete GPU on hybrid Windows systems. This is an official Electron
// switch and is a no-op when only one GPU is available.
if (process.platform === 'win32') {
  app.commandLine.appendSwitch('force_high_performance_gpu');
}

let resolveGpuInfoReady;
const gpuInfoReady = new Promise((resolve) => {
  resolveGpuInfoReady = resolve;
});
let gpuInfoReadySettled = false;

function markGpuInfoReady() {
  if (gpuInfoReadySettled) {
    return;
  }
  gpuInfoReadySettled = true;
  resolveGpuInfoReady();
}

app.once('gpu-info-update', markGpuInfoReady);
setTimeout(markGpuInfoReady, 2000).unref?.();

const HELP_URL = 'https://github.com/bergkamp/video-comparison-player#readme';
const APPLICATION_PATH = path.join(__dirname, '..', 'public', 'index.html');
const APPLICATION_URL = pathToFileURL(APPLICATION_PATH).href;
let mainWindow = null;
let applicationMenu = null;
let powerBlockerId = null;

function numericGpuId(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value !== 'string') {
    return 0;
  }
  const trimmed = value.trim().toLowerCase();
  return Number.parseInt(trimmed, trimmed.startsWith('0x') ? 16 : 10) || 0;
}

function gpuVendorName(vendorId) {
  const vendors = new Map([
    [0x10de, 'NVIDIA'],
    [0x1002, 'AMD'],
    [0x8086, 'Intel'],
    [0x5143, 'Qualcomm'],
    [0x106b, 'Apple'],
  ]);
  return vendors.get(numericGpuId(vendorId)) || 'Unknown';
}

function describeGpuDevices(gpuInfo) {
  const devices = Array.isArray(gpuInfo?.gpuDevice) ? gpuInfo.gpuDevice : [];
  return devices.map((device) => ({
    active: Boolean(device.active),
    vendorId: numericGpuId(device.vendorId),
    deviceId: numericGpuId(device.deviceId),
    vendor: gpuVendorName(device.vendorId),
  }));
}

function isTrustedSender(event) {
  return validateSender(event, mainWindow, APPLICATION_URL);
}

function setPlaybackPowerState(active) {
  if (active && powerBlockerId === null) {
    powerBlockerId = powerSaveBlocker.start('prevent-display-sleep');
    return;
  }

  if (!active && powerBlockerId !== null) {
    if (powerSaveBlocker.isStarted(powerBlockerId)) {
      powerSaveBlocker.stop(powerBlockerId);
    }
    powerBlockerId = null;
  }
}


function getWindowForEvent(event) {
  const windowFromSender = BrowserWindow.fromWebContents(event.sender);
  if (!windowFromSender || windowFromSender.isDestroyed()) {
    throw new Error('The application window is unavailable.');
  }
  return windowFromSender;
}

function publishBorderlessFullscreenState(window) {
  if (!window || window.isDestroyed() || window.webContents.isDestroyed()) {
    return;
  }

  window.webContents.send(
    'window:borderless-fullscreen-changed',
    window.isFullScreen()
  );
}

function configureMenuForFullscreen(window, fullscreen) {
  if (!window || window.isDestroyed() || process.platform === 'darwin') {
    return;
  }

  if (fullscreen) {
    // Removing the per-window menu prevents the single Alt key from revealing
    // it over video while the native window is fullscreen.
    window.setMenu(null);
    window.setMenuBarVisibility(false);
    return;
  }

  window.setMenu(applicationMenu);
  window.setAutoHideMenuBar(true);
  window.setMenuBarVisibility(false);
}

function setBorderlessFullscreen(window, fullscreen) {
  if (!window || window.isDestroyed()) {
    return false;
  }

  const requestedState = Boolean(fullscreen);
  configureMenuForFullscreen(window, requestedState);

  if (window.isFullScreen() !== requestedState) {
    window.setFullScreen(requestedState);
  } else {
    publishBorderlessFullscreenState(window);
  }

  return requestedState;
}

function toggleBorderlessFullscreen(window) {
  return setBorderlessFullscreen(window, !window.isFullScreen());
}

function createApplicationMenu() {
  const template = [
    {
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
      ],
    },
    {
      label: 'Help',
      submenu: [
        {
          label: 'Project documentation',
          click: () => shell.openExternal(HELP_URL),
        },
      ],
    },
  ];

  applicationMenu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(applicationMenu);
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 420,
    minHeight: 420,
    show: false,
    icon: path.join(__dirname, '..', 'assets', 'icon.png'),
    backgroundColor: '#090b10',
    darkTheme: true,
    autoHideMenuBar: process.platform !== 'darwin',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      backgroundThrottling: false,
    },
  });

  mainWindow.loadFile(APPLICATION_PATH);
  if (process.platform !== 'darwin') {
    mainWindow.setMenuBarVisibility(false);
  }

  mainWindow.on('enter-full-screen', () => {
    configureMenuForFullscreen(mainWindow, true);
    publishBorderlessFullscreenState(mainWindow);
  });
  mainWindow.on('leave-full-screen', () => {
    configureMenuForFullscreen(mainWindow, false);
    publishBorderlessFullscreenState(mainWindow);
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
    publishBorderlessFullscreenState(mainWindow);
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
    setPlaybackPowerState(false);
  });
}

function registerIpc() {
  ipcMain.handle('media:probe', async (event, filePath) => {
    if (!isTrustedSender(event)) {
      throw new Error('Rejected media probe request from an untrusted sender.');
    }
    return probeMedia(filePath);
  });

  ipcMain.handle('app:runtime-info', async (event) => {
    if (!isTrustedSender(event)) {
      throw new Error('Rejected runtime request from an untrusted sender.');
    }

    await gpuInfoReady;

    let gpuInfo = null;
    try {
      gpuInfo = await app.getGPUInfo('basic');
    } catch (error) {
      console.warn('Basic GPU information is unavailable:', error);
    }

    const gpuDevices = describeGpuDevices(gpuInfo);
    const activeGpu = gpuDevices.find((device) => device.active) || gpuDevices[0] || null;
    const gpuFeatures = app.getGPUFeatureStatus();

    return {
      platform: process.platform,
      arch: process.arch,
      versions: {
        electron: process.versions.electron,
        chrome: process.versions.chrome,
        node: process.versions.node,
      },
      hardwareAcceleration: app.isHardwareAccelerationEnabled(),
      gpu: gpuFeatures,
      gpuInfo,
      gpuDevices,
      activeGpu,
      highPerformanceGpuRequested: process.platform === 'win32',
      videoAccelerationApi: process.platform === 'win32'
        ? 'D3D11 / DXVA'
        : process.platform === 'darwin'
          ? 'VideoToolbox'
          : 'Chromium platform decoder',
    };
  });

  ipcMain.handle('window:get-borderless-fullscreen', (event) => {
    if (!isTrustedSender(event)) {
      throw new Error('Rejected fullscreen state request from an untrusted sender.');
    }
    return getWindowForEvent(event).isFullScreen();
  });

  ipcMain.handle('window:toggle-borderless-fullscreen', (event) => {
    if (!isTrustedSender(event)) {
      throw new Error('Rejected fullscreen request from an untrusted sender.');
    }
    return toggleBorderlessFullscreen(getWindowForEvent(event));
  });

  ipcMain.on('playback:set-active', (event, active) => {
    if (!isTrustedSender(event)) {
      return;
    }
    setPlaybackPowerState(Boolean(active));
  });

  ipcMain.handle('app:open-help', async (event) => {
    if (!isTrustedSender(event)) {
      throw new Error('Rejected external navigation from an untrusted sender.');
    }
    await shell.openExternal(HELP_URL);
  });
}

app.whenReady().then(() => {
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false);
  });

  app.on('web-contents-created', (_event, contents) => {
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
    contents.on('will-navigate', (navigationEvent, url) => {
      if (url !== APPLICATION_URL) {
        navigationEvent.preventDefault();
      }
    });
  });

  registerIpc();
  createApplicationMenu();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  setPlaybackPowerState(false);
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
