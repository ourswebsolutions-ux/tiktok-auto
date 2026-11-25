'use strict';
// Google Gemini (gemini.google.com) automation in the user's own logged-in Chrome.
// Same post flow as ChatGPT (prompt sent exactly as written -> image -> caption/hashtags), via generatePostWith().
// Verified on gemini.google.com on 2026-11-26:
//   composer:   rich-textarea .ql-editor[contenteditable=true] (aria-label "Enter a prompt for Gemini")
//   send:       button[aria-label="Send message"]; while working: button[aria-label="Stop response"]
//   answer:     last <model-response>; text in <message-content>; "Creating your image" while drawing
//   image:      <generated-image> img (blob:), loaded from lh3.googleusercontent.com/rd-gg(-dl)/...;
//               "=s0" on that URL returns the original (768x1376 JPEG on the free plan)
//   regenerate: "Redo" button on the answer

const { NeedsHumanError, RateLimitError, UiError, sleep, waitUntil, visible, safeClick, detectChallenge } = require('./util');
const { generatePostWith, imageSize } = require('./chatgpt');

const GEMINI_URL = 'https://gemini.google.com/app';
const COMPOSER = 'rich-textarea .ql-editor[contenteditable="true"], div[contenteditable="true"][aria-label*="prompt" i]';
const SEND = 'button[aria-label="Send message"], button[aria-label*="Send" i]';
const STOP = 'button[aria-label="Stop response"], button[aria-label*="Stop" i]';
const IMAGE_URL = /googleusercontent\.com\/rd-gg/;
const LIMIT_RE = /(reached|hit) (your|the) (daily )?(image )?(creation |generation )?limit|limit for (creating|generating) images|can['’]t (create|generate|make) (any )?more images|try again tomorrow|come back tomorrow|out of (image|images|credits)|upgrade to (google ai|gemini) (pro|ultra|advanced|plus)/i;
const ERROR_RE = /something went wrong|an error occurred|(please )?try again|couldn['’]t (generate|create)|unable to (generate|create)|network error|timed out/i;

const DISMISS_RE = /^(close|dismiss|not now|no thanks|got it|ok|okay|maybe later|skip)$/i;
async function dismissOverlays(page) {
  for (let i = 0; i < 3; i++) {
    const dlg = page.locator('[role="dialog"]:visible, mat-dialog-container:visible').first();
    if (!(await visible(dlg))) return;
    const btn = dlg.getByRole('button', { name: DISMISS_RE }).first();
    if (await visible(btn)) await btn.click({ timeout: 5000 }).catch(() => {});
    else await page.keyboard.press('Escape').catch(() => {});
    await sleep(800);
  }
}

async function signedOut(page) {
  const signIn = page.getByRole('link', { name: /^sign in$/i }).or(page.getByRole('button', { name: /^sign in$/i }));
  return visible(signIn);
}

async function lastTurn(page) {
  return page.evaluate(() => {
    const all = document.querySelectorAll('model-response');
    const mr = all[all.length - 1] || null;
    const content = mr ? (mr.querySelector('message-content') || mr) : null;
    const text = content ? content.innerText.replace(/^\s*Gemini said\s*/i, '') : '';
    const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const imgs = mr ? [...mr.querySelectorAll('generated-image img, single-image img')].filter(vis) : [];
    const imageCard = !!mr && (!!mr.querySelector('generated-image, single-image') || /creating your image/i.test(mr.innerText));
    const redo = !!mr && [...mr.querySelectorAll('button')].some((b) => /^(redo|regenerate|retry|try again)$/i.test((b.getAttribute('aria-label') || b.innerText || '').trim()));
    return {
      count: all.length,
      text,
      turnText: mr ? mr.innerText.slice(-600) : '',
      imageLabel: imageCard,
      imageLoaded: imgs.some((im) => im.complete && im.naturalWidth >= 512),
      redo,
      drawing: !!mr && /creating your image/i.test(mr.innerText),
    };
  });
}

// Opens a NEW, empty Gemini chat (every post gets its own chat).
async function openChat(page, opts = {}) {
  await page.goto(GEMINI_URL, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await waitUntil(page, async () => (await visible(page.locator(COMPOSER))) || (await signedOut(page)),
    { timeout: 60000, label: 'Gemini message box', site: 'Gemini', shouldAbort: opts.shouldAbort });
  if (await signedOut(page)) {
    throw new NeedsHumanError('Gemini is not logged in in your Chrome profile. Please sign in to gemini.google.com in Chrome.', { site: 'Gemini', page });
  }
  await sleep(1500);
  await dismissOverlays(page);
  if ((await lastTurn(page)).count > 0) {
    const newChat = page.getByRole('button', { name: /^new chat$/i }).or(page.getByRole('link', { name: /^new chat$/i })).first();
    await safeClick(page, newChat, 'Gemini "New chat"', dismissOverlays);
    await waitUntil(page, async () => (await lastTurn(page)).count === 0, { timeout: 20000, label: 'a new empty Gemini chat', site: 'Gemini' });
  }
}

// Read-only check used by "Check Chrome". Sends nothing.
async function checkGemini(page) {
  await page.goto(GEMINI_URL, { waitUntil: 'domcontentloaded', timeout: 90000 });
  try {
    await waitUntil(page, async () => (await visible(page.locator(COMPOSER))) || (await signedOut(page)), { timeout: 45000, label: 'Gemini message box', site: 'Gemini' });
  } catch (e) {
    const ch = await detectChallenge(page);
    return { ok: false, detail: ch ? `${ch} - solve it in Chrome` : `page did not load normally (${e.message})` };
  }
  if (await signedOut(page)) return { ok: false, detail: 'reachable, but NOT signed in - sign in to gemini.google.com in this Chrome' };
  return { ok: true, detail: 'reachable and signed in' };
}

async function typeIntoComposer(page, text) {
  const box = page.locator(COMPOSER).first();
  await dismissOverlays(page);
  await safeClick(page, box, 'the Gemini message box', dismissOverlays);
  await page.keyboard.press('Control+A');
  await page.keyboard.press('Backspace');
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]) await page.keyboard.insertText(lines[i]);
    if (i < lines.length - 1) await page.keyboard.press('Shift+Enter');
  }
  await sleep(500);
  const typed = (await box.innerText()).replace(/\s+/g, ' ');
  if (!typed.includes(text.replace(/\s+/g, ' ').slice(0, 40))) throw new UiError('Could not type the message into Gemini');
}

// Sends a message (text = null: press Gemini's "Redo" on the last answer) and waits for the complete answer.
async function ask(page, text, { timeout = 180000, expectImage = false, imageReady = () => false, shouldAbort } = {}) {
  const before = await lastTurn(page);
  const redoBtn = page.locator('model-response').last().getByRole('button', { name: /^redo$/i }).first();
  if (text === null && (await visible(redoBtn))) {
    await safeClick(page, redoBtn, 'Gemini "Redo"', dismissOverlays);
    before.count = -1;
    await sleep(3000);
  } else {
    await typeIntoComposer(page, text === null ? 'Please regenerate the image now, following my instructions above exactly.' : text);
    const send = page.locator(SEND).first();
    if (await visible(send)) await safeClick(page, send, 'the Gemini send button', dismissOverlays);
    else await page.keyboard.press('Enter');
  }
  await waitUntil(page, async () => {
    const t = await lastTurn(page);
    return t.count > before.count || (await visible(page.locator(STOP)));
  }, { timeout: 60000, label: 'Gemini to start answering', site: 'Gemini', shouldAbort });

  let lastSig = '';
  let stableSince = Date.now();
  const result = await waitUntil(page, async () => {
    const t = await lastTurn(page);
    const ready = expectImage && (imageReady() || t.imageLoaded);
    const sig = `${t.text.length}|${t.imageLabel}|${ready}|${t.drawing}`;
    if (sig !== lastSig) { lastSig = sig; stableSince = Date.now(); }
    if ((await visible(page.locator(STOP))) || t.drawing) return null;
    const stableFor = Date.now() - stableSince;
    if (expectImage) {
      if (ready && stableFor > 3000) return t;
      if (!t.imageLabel && t.text.trim() && stableFor > 8000) return t; // answered without an image
      return null;
    }
    return t.text.trim() && stableFor > 2500 ? t : null;
  }, { timeout, interval: 1000, label: expectImage ? 'Gemini image generation' : 'Gemini answer', site: 'Gemini', shouldAbort });

  const shown = `${result.text} ${result.turnText}`;
  if (LIMIT_RE.test(shown)) throw new RateLimitError(`Gemini image/usage limit reached: ${shown.replace(/\s+/g, ' ').trim().slice(0, 160)}`, 2 * 3600e3);
  result.retryButton = result.redo;
  if (!result.imageLabel && ERROR_RE.test(result.text) && result.text.length < 300) result.error = true;
  return result;
}

// Sends `message` exactly as given and captures the generated image from the response Gemini itself loads.
async function sendAndCaptureImage(page, message, { shouldAbort } = {}) {
  const urls = [];
  const bodies = [];
  const onResponse = async (r) => {
    if (!IMAGE_URL.test(r.url()) || !/^image\//.test(r.headers()['content-type'] || '')) return;
    urls.push(r.url());
    try {
      const body = await r.body();
      const size = imageSize(body);
      if (size && size.w >= 512 && size.h >= 512) bodies.push({ body, size });
    } catch (_) { /* body unavailable */ }
  };
  page.on('response', onResponse);
  let result;
  try {
    result = await ask(page, message, { expectImage: true, imageReady: () => bodies.length > 0, timeout: 8 * 60 * 1000, shouldAbort });
  } finally {
    page.off('response', onResponse);
  }
  let best = null;
  const url = urls[urls.length - 1];
  if (url) {
    // "=s0" returns the original image as JPEG (fetched by the Gemini page itself, with its own session).
    const [path, query] = url.split('?');
    const original = `${path.replace(/=[^=/]*$/, '')}=s0${query ? `?${query}` : ''}`;
    const b64 = await page.evaluate(async (u) => {
      const res = await fetch(u, { credentials: 'include' });
      if (!res.ok) return null;
      const bytes = new Uint8Array(await res.arrayBuffer());
      let s = '';
      for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
      return btoa(s);
    }, original).catch(() => null);
    if (b64) {
      const body = Buffer.from(b64, 'base64');
      const size = imageSize(body);
      if (size && size.w >= 512) best = { body, size };
    }
  }
  if (!best && bodies.length) best = bodies[bodies.length - 1];
  return { image: best, text: result.text, retryButton: !!result.retryButton, error: !!result.error };
}

const GEMINI_DRIVER = { name: 'Gemini', openChat, sendAndCaptureImage, ask };
const generatePost = (page, opts) => generatePostWith(GEMINI_DRIVER, page, opts);

module.exports = { checkGemini, generatePost, openChat };
