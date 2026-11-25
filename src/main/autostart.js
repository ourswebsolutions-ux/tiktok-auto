'use strict';
// Start the app (hidden, tray only) when the user logs in to the computer.
const fs = require('fs');
const os = require('os');
const path = require('path');

function enableAutostart(app, log) {
  try {
    if (process.platform === 'linux') {
      const dir = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'autostart');
      fs.mkdirSync(dir, { recursive: true });
      const exe = process.execPath; // packaged app binary, or the electron binary in development
      const appArg = app.isPackaged ? '' : ` "${app.getAppPath()}"`;
      const appDir = app.isPackaged ? path.dirname(exe) : app.getAppPath();
      // Wait (up to 2 min) for the drive holding the app to be mounted before launching.
      const cmd = `for i in $(seq 60); do [ -e "${appDir}" ] && break; sleep 2; done; exec "${exe}"${appArg} --hidden`;
      const entry = [
        '[Desktop Entry]',
        'Type=Application',
        'Name=TikTok Auto Poster',
        `Exec=sh -c '${cmd.replace(/'/g, "'\\''")}'`,
        `Icon=${path.join(appDir, 'assets', 'icon.png')}`,
        'X-GNOME-Autostart-enabled=true',
        'X-GNOME-Autostart-Delay=20',
        'Terminal=false',
        '',
      ].join('\n');
      fs.writeFileSync(path.join(dir, 'tiktok-auto-poster.desktop'), entry);
    } else {
      app.setLoginItemSettings({ openAtLogin: true, args: app.isPackaged ? ['--hidden'] : [app.getAppPath(), '--hidden'] });
    }
  } catch (e) {
    log.warn(`Could not enable start on boot: ${e.message}`);
  }
}

module.exports = { enableAutostart };
