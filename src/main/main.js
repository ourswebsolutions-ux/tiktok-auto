'use strict';
// Electron entry point. Closing the window only hides it: the automation keeps running in the
// background (tray icon) until "Quit" is chosen from the tray menu.

const path = require('path');
const fs = require('fs');
const { app, BrowserWindow, Tray, Menu, ipcMain, Notification, nativeImage, shell } = require('electron');
const { Store } = require('./db');
const { Engine } = require('./engine');
const { ChromeConnection } = require('./automation/chrome');
const { createLogger } = require('./logger');
const { enableAutostart } = require('./autostart');
const { MAX_DAILY } = require('./scheduler');
const { setupAutoUpdate } = require('./updater');

app.setName('tiktok-auto-poster');
const startHidden = process.argv.includes('--hidden');

if (!app.requestSingleInstanceLock()) {
  // Another instance is already running the automation: just ask it to show its window.
  app.quit();
} else {
  const ROOT = path.join(__dirname, '..', '..');
  const ICON = path.join(ROOT, 'assets', 'icon.png');
  let win = null;
  let tray = null;
  let quitting = false;
  let engine = null;
  let updater = null;

  function showWindow() {
    if (!win) {
      win = new BrowserWindow({
        width: 1100,
        height: 820,
        minWidth: 760,
        minHeight: 560,
        title: 'TikTok Auto Poster',
        icon: ICON,
        backgroundColor: '#f6f6f8',
        autoHideMenuBar: true,
        webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
      });
      win.loadFile(path.join(ROOT, 'dist', 'index.html'));
      win.on('close', (e) => {
        if (!quitting) { e.preventDefault(); win.hide(); }
      });
      win.on('closed', () => { win = null; });
    }
    win.show();
    win.focus();
  }

  function refreshTray() {
    if (!tray || !engine) return;
    const running = engine.running;
    const phase = engine.status.phase;
    const label = phase === 'attention' ? 'Needs your attention' : phase === 'chrome' ? 'Waiting for Chrome' : running ? 'Running' : 'Stopped';
    tray.setToolTip(`TikTok Auto Poster - ${label}`);
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: `Status: ${label}`, enabled: false },
      { label: `Version ${app.getVersion()}${updater && updater.state.status === 'ready' ? ` (update ${updater.state.version} ready)` : ''}`, enabled: false },
      { type: 'separator' },
      { label: 'Open Dashboard', click: showWindow },
      { label: 'Generate images', type: 'checkbox', checked: engine.genEnabled(), click: (item) => engine.setGenerate(item.checked) },
      { label: 'Auto upload to TikTok', type: 'checkbox', checked: engine.uploadEnabled(), click: (item) => engine.setUpload(item.checked) },
      { label: 'Stop everything', enabled: running, click: () => engine.stop() },
      { label: 'Check for Updates', enabled: !!(updater && app.isPackaged), click: () => updater.check() },
      { type: 'separator' },
      { label: 'Quit (stops automation)', click: () => { quitting = true; app.quit(); } },
    ]));
  }

  app.on('second-instance', () => showWindow());
  app.on('window-all-closed', () => { /* keep running in the tray */ });
  app.on('before-quit', () => { quitting = true; });

  app.whenReady().then(() => {
    const userData = app.getPath('userData');
    const dirs = {
      data: userData,
      media: path.join(userData, 'media'),
      screenshots: path.join(userData, 'screenshots'),
      logs: path.join(userData, 'logs'),
      // Every generated post (image + caption/hashtags/date) is also saved here for the user.
      export: path.join(app.getPath('documents'), 'TikTok Auto Poster Export'),
    };
    Object.values(dirs).forEach((d) => fs.mkdirSync(d, { recursive: true }));
    const log = createLogger(dirs.logs);
    log.info(`Starting TikTok Auto Poster. Data folder: ${userData}`);

    const store = new Store(path.join(userData, 'app.db'));
    const chrome = new ChromeConnection({ log });
    const notify = (title, body) => {
      try { if (Notification.isSupported()) new Notification({ title, body: String(body || '').slice(0, 250), icon: ICON }).show(); } catch (_) { /* ignore */ }
    };
    engine = new Engine({ store, chrome, dirs, log, notify });

    let pending = null;
    engine.on('change', () => {
      refreshTray();
      if (pending) return;
      pending = setTimeout(() => { pending = null; if (win) win.webContents.send('state:changed'); }, 150);
    });

    ipcMain.handle('state:get', () => ({ ...engine.snapshot(), app: { version: app.getVersion(), update: updater ? updater.state : null } }));
    ipcMain.handle('prompt:add', (_e, text) => {
      const t = String(text || '').trim();
      if (!t) return { ok: false, message: 'Prompt is empty' };
      store.addPrompt(t.slice(0, 4000)); engine.emit('change'); return { ok: true };
    });
    ipcMain.handle('prompt:update', (_e, id, text) => {
      const t = String(text || '').trim();
      if (!t) return { ok: false, message: 'Prompt is empty' };
      store.updatePrompt(Number(id), t.slice(0, 4000)); engine.emit('change'); return { ok: true };
    });
    ipcMain.handle('prompt:delete', (_e, id) => { store.deletePrompt(Number(id)); engine.emit('change'); return { ok: true }; });
    ipcMain.handle('quantity:set', (_e, n) => {
      const q = Math.max(1, Math.min(MAX_DAILY, Math.round(Number(n) || 1)));
      engine.setDailyQuantity(q); return { ok: true, value: q };
    });
    ipcMain.handle('sound:set', (_e, v) => { engine.setSoundStyle(v); return { ok: true, value: engine.soundStyle() }; });
    ipcMain.handle('ai:set', (_e, p) => { engine.setAiProvider(p); return { ok: true, value: engine.aiProvider() }; });
    ipcMain.handle('mode:set', (_e, mode) => { engine.setSchedulingMode(mode); return { ok: true, value: engine.schedulingMode() }; });
    ipcMain.handle('genmode:set', (_e, mode, tabs) => engine.setGenMode(mode, tabs));
    ipcMain.handle('generate:set', (_e, on) => engine.setGenerate(!!on));
    ipcMain.handle('upload:set', (_e, on) => engine.setUpload(!!on));
    ipcMain.handle('export:open', async () => { fs.mkdirSync(dirs.export, { recursive: true }); const err = await shell.openPath(dirs.export); return { ok: !err, message: err }; });
    ipcMain.handle('automation:start', () => engine.start());
    ipcMain.handle('automation:stop', () => { engine.stop(); return { ok: true }; });
    ipcMain.handle('automation:resume', () => { engine.resumeAfterAttention(); return { ok: true }; });
    ipcMain.handle('chrome:check', () => engine.checkChrome());

    try {
      tray = new Tray(nativeImage.createFromPath(ICON));
      tray.on('click', showWindow);
      refreshTray();
    } catch (e) {
      log.warn(`System tray not available: ${e.message}`);
    }

    updater = setupAutoUpdate({
      app, log, notify,
      isBusy: () => engine.busy || ['working', 'connecting', 'stopping'].includes(engine.status.phase),
      onChange: () => engine.emit('change'),
    });
    enableAutostart(app, log);
    engine.init();
    if (!startHidden) showWindow();
  });
}
