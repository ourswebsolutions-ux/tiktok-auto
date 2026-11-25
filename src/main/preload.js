'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getState: () => ipcRenderer.invoke('state:get'),
  addPrompt: (text) => ipcRenderer.invoke('prompt:add', text),
  updatePrompt: (id, text) => ipcRenderer.invoke('prompt:update', id, text),
  deletePrompt: (id) => ipcRenderer.invoke('prompt:delete', id),
  setDailyQuantity: (n) => ipcRenderer.invoke('quantity:set', n),
  setSchedulingMode: (mode) => ipcRenderer.invoke('mode:set', mode),
  setAiProvider: (p) => ipcRenderer.invoke('ai:set', p),
  start: () => ipcRenderer.invoke('automation:start'),
  stop: () => ipcRenderer.invoke('automation:stop'),
  resume: () => ipcRenderer.invoke('automation:resume'),
  checkChrome: () => ipcRenderer.invoke('chrome:check'),
  onChange: (cb) => {
    const handler = () => cb();
    ipcRenderer.on('state:changed', handler);
    return () => ipcRenderer.removeListener('state:changed', handler);
  },
});
