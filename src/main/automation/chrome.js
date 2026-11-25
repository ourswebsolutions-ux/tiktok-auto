'use strict';
// Connects to the user's ALREADY-RUNNING everyday Chrome over the DevTools protocol (CDP).
//
// Rules this module follows:
//  * It never launches Chrome and never creates a profile.
//  * It never closes the user's browser or tabs it did not open itself.
//  * It never reads or exports cookies; pages simply run inside the user's own session.
//
// Chrome can expose CDP in two ways, both handled here:
//  1. Classic `--remote-debugging-port=9222` flag -> HTTP endpoint /json/version gives the ws URL.
//  2. Chrome's built-in "Allow remote debugging" switch (chrome://inspect/#remote-debugging) on the
//     default profile -> the HTTP /json endpoints return 404 and only a WebSocket is served. The ws path
//     is written by Chrome to the "DevToolsActivePort" file in the profile folder (we only READ it).
//     Chrome shows an "Allow remote debugging?" prompt for each new connection, so we keep ONE
//     long-lived connection instead of reconnecting for every post.

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const net = require('net');
const { chromium } = require('playwright-core');

const DEFAULT_PORT = 9222;
const HOST = '127.0.0.1';

const INSTRUCTIONS = [
  'Open your everyday Chrome with your remote-debugging shortcut (port 9222).',
  'Alternatively, in that Chrome open chrome://inspect/#remote-debugging and turn on "Allow remote debugging".',
  'If Chrome asks "Allow remote debugging?", click Allow.',
  'Then press "Check Chrome" (or Start) again. The app never launches a separate Chrome.',
].join('\n');

function chromeUserDataDirs() {
  const home = os.homedir();
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    return [path.join(local, 'Google', 'Chrome', 'User Data'), path.join(local, 'Google', 'Chrome Beta', 'User Data'), path.join(local, 'Chromium', 'User Data')];
  }
  if (process.platform === 'darwin') {
    const base = path.join(home, 'Library', 'Application Support');
    return [path.join(base, 'Google', 'Chrome'), path.join(base, 'Google', 'Chrome Beta'), path.join(base, 'Chromium')];
  }
  const cfg = process.env.XDG_CONFIG_HOME || path.join(home, '.config');
  return [path.join(cfg, 'google-chrome'), path.join(cfg, 'google-chrome-beta'), path.join(cfg, 'google-chrome-unstable'), path.join(cfg, 'chromium')];
}

function isPortOpen(port, host = HOST, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const sock = net.connect({ port, host });
    const done = (ok) => { sock.destroy(); resolve(ok); };
    sock.setTimeout(timeoutMs, () => done(false));
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
  });
}

function httpJson(url, timeoutMs = 2500) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        if (res.statusCode !== 200) return resolve(null);
        try { resolve(JSON.parse(body)); } catch (_) { resolve(null); }
      });
    });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
  });
}

// Returns { wsEndpoint, mode } or throws ChromeUnavailableError with a human-readable reason.
async function resolveEndpoint(port = DEFAULT_PORT) {
  if (!(await isPortOpen(port))) {
    throw new ChromeUnavailableError(`Chrome is not running with remote debugging on port ${port}.`);
  }
  const version = await httpJson(`http://${HOST}:${port}/json/version`);
  if (version && version.webSocketDebuggerUrl) {
    return { wsEndpoint: version.webSocketDebuggerUrl, mode: 'remote-debugging-port flag', browserVersion: version.Browser };
  }
  for (const dir of chromeUserDataDirs()) {
    const file = path.join(dir, 'DevToolsActivePort');
    let lines;
    try { lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).map((l) => l.trim()).filter(Boolean); } catch (_) { continue; }
    if (lines.length >= 2 && Number(lines[0]) === port && lines[1].startsWith('/devtools/browser/')) {
      return { wsEndpoint: `ws://${HOST}:${port}${lines[1]}`, mode: 'chrome://inspect remote debugging', profileDir: dir };
    }
  }
  throw new ChromeUnavailableError(`Something is listening on port ${port}, but no Chrome debugging endpoint was found.`);
}

class ChromeUnavailableError extends Error {
  constructor(message) { super(message); this.name = 'ChromeUnavailableError'; this.instructions = INSTRUCTIONS; }
}

class ChromeConnection {
  constructor({ port = DEFAULT_PORT, log = console } = {}) {
    this.port = port;
    this.log = log;
    this.browser = null;
    this.connecting = null;
    this.info = null;
    this.ownPages = new Set();
  }

  isConnected() { return !!(this.browser && this.browser.isConnected()); }

  // Cheap check without opening a CDP session (does not trigger Chrome's allow prompt).
  async probe() {
    try {
      const ep = await resolveEndpoint(this.port);
      return { available: true, connected: this.isConnected(), mode: ep.mode };
    } catch (e) {
      return { available: false, connected: false, reason: e.message, instructions: INSTRUCTIONS };
    }
  }

  async connect() {
    if (this.isConnected()) return this.browser;
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      const ep = await resolveEndpoint(this.port);
      this.log.info(`Connecting to everyday Chrome via ${ep.mode} ...`);
      let browser;
      try {
        // Generous timeout: Chrome may show an "Allow remote debugging?" prompt the user must accept.
        browser = await chromium.connectOverCDP(ep.wsEndpoint, { timeout: 120000 });
      } catch (e) {
        throw new ChromeUnavailableError(`Could not connect to Chrome (${e.message.split('\n')[0]}). If Chrome showed an "Allow remote debugging?" prompt, click Allow.`);
      }
      browser.on('disconnected', () => {
        this.log.warn('Chrome connection lost (Chrome closed, crashed or debugging was turned off).');
        this.browser = null;
        this.ownPages.clear();
      });
      this.browser = browser;
      this.info = { mode: ep.mode, version: browser.version() };
      this.log.info(`Connected to Chrome ${browser.version()} (${ep.mode}).`);
      return browser;
    })();
    try { return await this.connecting; } finally { this.connecting = null; }
  }

  // The user's real profile is the browser's default context.
  async context() {
    const browser = await this.connect();
    const ctx = browser.contexts()[0];
    if (!ctx) throw new ChromeUnavailableError('Connected to Chrome, but no browser profile window is open. Open a normal Chrome window.');
    return ctx;
  }

  // Opens a new tab in the user's Chrome. Only tabs opened here are ever closed by the app.
  async newPage() {
    const ctx = await this.context();
    const page = await ctx.newPage();
    page.setDefaultTimeout(30000);
    page.setDefaultNavigationTimeout(60000);
    this.ownPages.add(page);
    page.on('close', () => this.ownPages.delete(page));
    return page;
  }

  async closePage(page) {
    if (!page) return;
    this.ownPages.delete(page);
    try { if (!page.isClosed()) await page.close(); } catch (_) { /* tab already gone */ }
  }

  async closeOwnPages() {
    for (const p of [...this.ownPages]) await this.closePage(p);
  }
}

module.exports = { ChromeConnection, ChromeUnavailableError, resolveEndpoint, INSTRUCTIONS, DEFAULT_PORT };
