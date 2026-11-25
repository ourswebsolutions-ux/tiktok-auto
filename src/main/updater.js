'use strict';
// Auto-update from GitHub Releases (installed builds only: Windows installer, Linux AppImage).
// Checks on startup and every 4 hours, downloads in the background and installs only while the
// automation is idle, so a post is never interrupted. After restarting, automation resumes by itself.

const { autoUpdater } = require('electron-updater');

const CHECK_EVERY_MS = 4 * 60 * 60 * 1000;
const FIRST_CHECK_DELAY_MS = 20 * 1000;

function setupAutoUpdate({ app, log, notify, isBusy, onChange }) {
  const state = { status: 'idle', version: null, progress: null, message: '' };
  const set = (patch) => { Object.assign(state, patch); onChange(); };

  if (!app.isPackaged) {
    set({ status: 'disabled', message: 'Auto-update is active in installed releases' });
    return { state, check: async () => {} };
  }
  if (process.platform === 'linux' && !process.env.APPIMAGE) {
    set({ status: 'disabled', message: 'Auto-update needs the AppImage version' });
    return { state, check: async () => {} };
  }

  autoUpdater.logger = {
    info: (m) => log.info(`[updater] ${m}`),
    warn: (m) => log.warn(`[updater] ${m}`),
    error: (m) => log.error(`[updater] ${m}`),
    debug: () => {},
  };
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  let installTimer = null;
  const installWhenIdle = () => {
    if (installTimer) return;
    const tryInstall = () => {
      if (isBusy()) return; // wait until no post is being generated/published
      clearInterval(installTimer);
      log.info(`Installing update ${state.version} and restarting.`);
      setImmediate(() => autoUpdater.quitAndInstall(true, true));
    };
    installTimer = setInterval(tryInstall, 30 * 1000);
    tryInstall();
  };

  autoUpdater.on('checking-for-update', () => set({ status: 'checking', message: '' }));
  autoUpdater.on('update-not-available', () => set({ status: 'up-to-date', message: '' }));
  autoUpdater.on('update-available', (info) => {
    set({ status: 'downloading', version: info.version, progress: 0 });
    log.info(`Update ${info.version} found, downloading.`);
  });
  autoUpdater.on('download-progress', (p) => set({ status: 'downloading', progress: Math.round(p.percent) }));
  autoUpdater.on('update-downloaded', (info) => {
    set({ status: 'ready', version: info.version, progress: 100 });
    notify('Update ready', `Version ${info.version} will be installed automatically when the automation is idle.`);
    installWhenIdle();
  });
  autoUpdater.on('error', (e) => set({ status: 'error', message: String(e && e.message ? e.message : e).split('\n')[0].slice(0, 200) }));

  const check = async () => {
    if (state.status === 'downloading' || state.status === 'ready') return;
    try { await autoUpdater.checkForUpdates(); } catch (e) { set({ status: 'error', message: e.message.split('\n')[0] }); }
  };
  setTimeout(check, FIRST_CHECK_DELAY_MS);
  setInterval(check, CHECK_EVERY_MS);
  return { state, check };
}

module.exports = { setupAutoUpdate };
