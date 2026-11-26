'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ---------- error types ----------
class NeedsHumanError extends Error {
  constructor(message, { site, page } = {}) { super(message); this.name = 'NeedsHumanError'; this.site = site; this.page = page; }
}
class RateLimitError extends Error {
  constructor(message, retryAfterMs = 60 * 60 * 1000) { super(message); this.name = 'RateLimitError'; this.retryAfterMs = retryAfterMs; }
}
class UiError extends Error { // site UI did not look/behave as expected
  constructor(message) { super(message); this.name = 'UiError'; }
}
class AbortedError extends Error {
  constructor() { super('Automation stopped'); this.name = 'AbortedError'; }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- text helpers ----------
const normalize = (s) => String(s || '').toLowerCase().normalize('NFKC').replace(/[^\p{L}\p{N}#]+/gu, ' ').replace(/\s+/g, ' ').trim();
const wordSet = (s) => new Set(normalize(s).replace(/#/g, ' ').split(' ').filter((w) => w.length > 2));
function jaccard(a, b) {
  const A = wordSet(a); const B = wordSet(b);
  if (!A.size || !B.size) return 0;
  let inter = 0; for (const w of A) if (B.has(w)) inter++;
  return inter / (A.size + B.size - inter);
}
const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');
const captionKey = (title, caption) => sha256(normalize(`${title} ${caption}`.replace(/#\S+/g, ''))).slice(0, 32);

// ---------- page helpers ----------
const CHALLENGE_SELECTORS = [
  ['iframe[src*="challenges.cloudflare.com"]', 'Cloudflare "verify you are human" check'],
  ['#challenge-form, #cf-challenge-running, #challenge-stage', 'Cloudflare security check'],
  ['#captcha-verify-container, #captcha_container, .captcha_verify_container, [class*="captcha-verify"], [class*="secsdk-captcha"], iframe[src*="captcha"]', 'CAPTCHA'],
];

// Returns a human-readable reason if a CAPTCHA / security challenge / login wall is visible, else null.
async function detectChallenge(page) {
  if (!page || page.isClosed()) return null;
  for (const [sel, label] of CHALLENGE_SELECTORS) {
    // eslint-disable-next-line no-await-in-loop
    const visible = await page.locator(sel).first().isVisible().catch(() => false);
    if (visible) return label;
  }
  const title = await page.title().catch(() => '');
  if (/just a moment|attention required|verify you are human/i.test(title)) return 'Security verification';
  const url = page.url();
  if (/auth\.openai\.com|\/auth\/login|tiktok\.com\/login|\/challenge|\/verify(\?|\/|$)/i.test(url)) return 'Login or account verification';
  return null;
}

// Poll until `check()` returns a truthy value; checks for challenges while waiting.
async function waitUntil(page, check, { timeout = 30000, interval = 700, label = 'page element', site, shouldAbort } = {}) {
  const end = Date.now() + timeout;
  let lastErr;
  while (Date.now() < end) {
    if (shouldAbort && shouldAbort()) throw new AbortedError();
    if (page.isClosed()) throw new Error('Browser tab was closed');
    try {
      // eslint-disable-next-line no-await-in-loop
      const v = await check();
      if (v) return v;
    } catch (e) { lastErr = e; }
    // eslint-disable-next-line no-await-in-loop
    const ch = await detectChallenge(page);
    if (ch) throw new NeedsHumanError(`${site || 'Website'}: ${ch} needs your attention in Chrome.`, { site, page });
    // eslint-disable-next-line no-await-in-loop
    await sleep(interval);
  }
  throw new UiError(`Timed out waiting for ${label}${lastErr ? ` (${lastErr.message.split('\n')[0]})` : ''}`);
}

async function visible(locator) {
  return locator.first().isVisible().catch(() => false);
}

// Click that survives popups/overlays: normal click -> close popups (dismiss) and retry -> forced click.
// Throws a readable error naming the element instead of a bare "locator.click: Timeout 30000ms exceeded".
async function safeClick(page, locator, label, dismiss) {
  try { await locator.click({ timeout: 20000 }); return; } catch (_) { /* try again below */ }
  if (dismiss) await dismiss(page).catch(() => {});
  await page.keyboard.press('Escape').catch(() => {});
  try { await locator.click({ timeout: 20000 }); return; } catch (_) { /* last attempt below */ }
  try { await locator.click({ timeout: 5000, force: true }); return; } catch (_) { /* give up */ }
  throw new UiError(`Could not click ${label} (it is hidden, disabled or covered by a popup)`);
}

// Watches a tab's network activity, so long operations (photo upload, publishing) are judged by PROGRESS instead of a
// fixed total time: a request still in flight or any data moving counts as "active". Only when nothing at all has
// happened for the idle timeout is the operation considered stalled.
class ActivityMonitor {
  constructor(page) {
    this.page = page;
    this.inflight = new Set();
    this.last = Date.now();
    this.onRequest = (r) => { this.inflight.add(r); this.touch(); };
    this.onDone = (r) => { this.inflight.delete(r); this.touch(); };
    this.onResponse = () => this.touch();
    page.on('request', this.onRequest);
    page.on('requestfinished', this.onDone);
    page.on('requestfailed', this.onDone);
    page.on('response', this.onResponse);
  }

  touch() { this.last = Date.now(); }

  // ms without any activity; 0 while a request (e.g. the photo upload itself) is still running.
  idleFor() { return this.inflight.size ? 0 : Date.now() - this.last; }

  dispose() {
    this.page.off('request', this.onRequest);
    this.page.off('requestfinished', this.onDone);
    this.page.off('requestfailed', this.onDone);
    this.page.off('response', this.onResponse);
  }
}

// Waits for check() like waitUntil, but without a short fixed timeout: it keeps waiting as long as the tab shows
// activity (network or a changing progress %). Fails only when stalled for idleTimeout or after maxTotal.
// onProgress(text) reports real progress ("45%") and slow-but-active phases - never invented progress.
async function waitActive(page, monitor, check, {
  idleTimeout = 3 * 60 * 1000, maxTotal = 45 * 60 * 1000, label = 'TikTok', site, shouldAbort, onProgress,
} = {}) {
  const start = Date.now();
  let lastPct = null;
  let slowReported = false;
  for (;;) {
    if (shouldAbort && shouldAbort()) throw new AbortedError();
    if (page.isClosed()) throw new Error('Browser tab was closed');
    // eslint-disable-next-line no-await-in-loop
    const v = await Promise.resolve(check()).catch(() => null);
    if (v) return v;
    // eslint-disable-next-line no-await-in-loop
    const ch = await detectChallenge(page);
    if (ch) throw new NeedsHumanError(`${site || 'Website'}: ${ch} needs your attention in Chrome.`, { site, page });
    // Real progress shown by the website (e.g. "Uploading 45%").
    // eslint-disable-next-line no-await-in-loop
    const pct = await page.evaluate(() => {
      const m = ((document.querySelector('main') || document.body).innerText || '').match(/(\d{1,3})\s?%/);
      return m ? Number(m[1]) : null;
    }).catch(() => null);
    if (pct !== null && pct !== lastPct) { lastPct = pct; monitor.touch(); if (onProgress) onProgress(`${label} - ${pct}%`); }
    const idle = monitor.idleFor();
    if (idle > idleTimeout) {
      throw new UiError(`${label}: no upload activity for ${Math.round(idle / 60000)} min (connection stalled)`);
    }
    if (Date.now() - start > maxTotal) throw new UiError(`${label}: still not finished after ${Math.round(maxTotal / 60000)} min`);
    if (!slowReported && Date.now() - start > 60000 && onProgress) {
      slowReported = true;
      onProgress(`${label} - delayed by a slow connection, still in progress`);
    }
    // eslint-disable-next-line no-await-in-loop
    await sleep(1000);
  }
}

// Opens a page in a way that survives slow / unstable internet: only waits for the first response (the caller
// then waits for the actual element it needs) and retries network errors (reset, timeout, offline) up to 3 times.
const NETWORK_ERROR_RE = /net::ERR_|Timeout \d+ms exceeded|NS_ERROR|ECONNRESET|socket hang up/i;
async function gotoSafe(page, url, { tries = 3, timeout = 120000 } = {}) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      // eslint-disable-next-line no-await-in-loop
      await page.goto(url, { waitUntil: 'commit', timeout });
      return;
    } catch (e) {
      lastErr = e;
      if (!NETWORK_ERROR_RE.test(e.message)) throw e;
      // eslint-disable-next-line no-await-in-loop
      await sleep(10000 * (i + 1));
    }
  }
  throw new Error(`Could not open ${url} (slow or no internet): ${lastErr.message.split('\n')[0]}`);
}

async function screenshot(page, dir, name) {
  if (!page || page.isClosed()) return null;
  try {
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${new Date().toISOString().replace(/[:.]/g, '-')}_${name.replace(/[^\w-]+/g, '_')}.png`);
    await page.screenshot({ path: file, timeout: 15000 });
    return file;
  } catch (_) { return null; }
}

module.exports = {
  NeedsHumanError, RateLimitError, UiError, AbortedError,
  sleep, normalize, wordSet, jaccard, sha256, captionKey,
  detectChallenge, waitUntil, visible, safeClick, gotoSafe, screenshot, ActivityMonitor, waitActive,
};
