'use strict';
const fs = require('fs');
const path = require('path');

function createLogger(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const write = (level, msg) => {
    const now = new Date();
    const line = `${now.toISOString()} [${level}] ${msg}`;
    // eslint-disable-next-line no-console
    console.log(line);
    const file = path.join(dir, `app-${now.toISOString().slice(0, 10)}.log`);
    try { fs.appendFileSync(file, `${line}\n`); } catch (_) { /* disk issue: still logged to console */ }
  };
  return {
    info: (m) => write('INFO', m),
    warn: (m) => write('WARN', m),
    error: (m) => write('ERROR', m),
    dir,
  };
}

module.exports = { createLogger };
