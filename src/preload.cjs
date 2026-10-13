'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('desktopApi', {
  probeFile(file) {
    const filePath = webUtils.getPathForFile(file);
    if (!filePath) {
      return Promise.reject(new Error('Electron could not resolve this file to a local path.'));
    }
    return ipcRenderer.invoke('media:probe', filePath);
  },
  getRuntimeInfo() {
    return ipcRenderer.invoke('app:runtime-info');
  },
  getBorderlessFullscreenState() {
    return ipcRenderer.invoke('window:get-borderless-fullscreen');
  },
  toggleBorderlessFullscreen() {
    return ipcRenderer.invoke('window:toggle-borderless-fullscreen');
  },
  onBorderlessFullscreenChanged(callback) {
    if (typeof callback !== 'function') {
      throw new TypeError('A fullscreen state callback is required.');
    }

    const listener = (_event, active) => callback(Boolean(active));
    ipcRenderer.on('window:borderless-fullscreen-changed', listener);
    return () => {
      ipcRenderer.removeListener('window:borderless-fullscreen-changed', listener);
    };
  },
  setPlaybackActive(active) {
    ipcRenderer.send('playback:set-active', Boolean(active));
  },
  openHelp() {
    return ipcRenderer.invoke('app:open-help');
  },
});
