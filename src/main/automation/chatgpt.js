'use strict';
// ChatGPT.com automation (runs inside the user's own logged-in Chrome session).
// Selectors verified against chatgpt.com on 2026-11-25:
//   composer:  the VISIBLE .ProseMirror[contenteditable=true] (ChatGPT also renders a hidden 0x0 copy)
//   send:      button[aria-label="Send"]
//   turn:      [data-talvt-turn-state]  ("in_progress" while answering, "complete" when done)
//   reply:     [data-response-body] inside the turn
// Older/alternative markup is kept as a fallback.

const fs = require('fs');
const { NeedsHumanError, RateLimitError, UiError, sleep, waitUntil, visible, safeClick, detectChallenge } = require('./util');

// A regular chat is required: ChatGPT does not allow image generation in temporary chats.
const CHAT_URL = 'https://chatgpt.com/';
const COMPOSER = '.ProseMirror[contenteditable="true"], #prompt-textarea, textarea[name="prompt-textarea"]';
const SEND = 'button[aria-label="Send"], button[data-testid="send-button"], #composer-submit-button, button[aria-label="Send prompt"]';
const STOP = 'button[aria-label="Stop"], button[data-testid="stop-button"], button[aria-label="Stop streaming"]';
// Only real usage limits wait; a plain "something went wrong / try again" is retried right away.
// Verified 2026-11-26 on ChatGPT Free: a "You're out of images" card and "There's not enough usage available on your plan
// to create images right now, but more will be available after 5:59 PM."
const LIMIT_RE = /(you['’]ve|you have) (hit|reached) (the|your)[^.]{0,60}limit|limit (resets|will reset)|reached the current usage cap|image generation (limit|quota)|upgrade to (plus|pro|go) to (create|generate|keep)|not enough usage available|you['’]re out of images|more will be available (after|at|in)/i;

// "... available after 5:59 PM" -> milliseconds until then (+2 min). Falls back to 30 minutes.
function limitResetDelay(text, now = Date.now()) {
  const m = String(text).match(/available (?:after|at) (\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
  if (!m) return 30 * 60 * 1000;
  let h = Number(m[1]) % 24;
  const min = Number(m[2] || 0);
  if (m[3]) { const pm = /pm/i.test(m[3]); if (h === 12) h = pm ? 12 : 0; else if (pm) h += 12; }
  const t = new Date(now);
  t.setHours(h, min, 0, 0);
  if (t.getTime() <= now) t.setDate(t.getDate() + 1);
  return Math.min(24 * 3600e3, Math.max(5 * 60 * 1000, t.getTime() - now + 2 * 60 * 1000));
}
// ChatGPT-side glitches that should simply be regenerated.
const TRANSIENT_RE = /something went wrong|an error occurred|error (while )?(generating|creating)|network error|(please )?try again|couldn['’]t (generate|create|finish)|failed to (generate|create)|unable to (generate|create) (the |an |your )?image|too many requests|timed out|is taking longer/i;
const REFUSAL_RE = /(i can['’]t|i cannot|i['’]m unable to|i am unable to|unable to) (help|create|generate|make|fulfill)|violates? (our|the) (content )?polic/i;

async function ensureLoggedIn(page) {
  const loginBtn = page.getByRole('button', { name: /^log in$/i }).or(page.getByRole('link', { name: /^log in$/i }));
  if (await visible(loginBtn)) {
    throw new NeedsHumanError('ChatGPT is not logged in in your Chrome profile. Please log in to chatgpt.com in Chrome.', { site: 'ChatGPT', page });
  }
}

// Closes ChatGPT popups (upgrade offers, feature announcements, ...) that can cover the message box.
const DISMISS_RE = /^(close|dismiss|not now|maybe later|no thanks|stay on (the )?free( plan)?|got it|okay|ok|skip)$/i;
async function dismissOverlays(page) {
  for (let i = 0; i < 3; i++) {
    const dlg = page.locator('[role="dialog"]:visible, [data-testid="modal"]:visible').first();
    if (!(await visible(dlg))) return;
    const btn = dlg.getByRole('button', { name: DISMISS_RE }).first();
    if (await visible(btn)) await btn.click({ timeout: 5000 }).catch(() => {});
    else await page.keyboard.press('Escape').catch(() => {});
    await sleep(800);
  }
}

// Opens a NEW, empty chat (every post gets its own chat).
async function openChat(page, opts = {}) {
  await page.goto(CHAT_URL, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await waitUntil(page, () => visible(page.locator(COMPOSER).filter({ visible: true })), { timeout: 60000, label: 'ChatGPT message box', site: 'ChatGPT', shouldAbort: opts.shouldAbort });
  await sleep(1500);
  await ensureLoggedIn(page);
  await dismissOverlays(page);
  if ((await lastTurn(page)).count > 0) {
    // An old conversation is showing: start a new chat explicitly.
    const newChat = page.getByRole('link', { name: /^new chat$/i }).or(page.getByRole('button', { name: /^new chat$/i })).first();
    await safeClick(page, newChat, 'ChatGPT "New chat"', dismissOverlays);
    await waitUntil(page, async () => (await lastTurn(page)).count === 0, { timeout: 20000, label: 'a new empty ChatGPT chat', site: 'ChatGPT' });
  }
}

// Read-only check used by "Check Chrome" and the startup check. Sends nothing.
async function checkChatGPT(page) {
  await page.goto('https://chatgpt.com/', { waitUntil: 'domcontentloaded', timeout: 90000 });
  try {
    await waitUntil(page, () => visible(page.locator(COMPOSER).filter({ visible: true })), { timeout: 45000, label: 'ChatGPT message box', site: 'ChatGPT' });
  } catch (e) {
    const ch = await detectChallenge(page);
    return { ok: false, detail: ch ? `${ch} - solve it in Chrome` : `page did not load normally (${e.message})` };
  }
  await sleep(2000);
  const loginBtn = page.getByRole('button', { name: /^log in$/i }).or(page.getByRole('link', { name: /^log in$/i }));
  if (await visible(loginBtn)) return { ok: false, detail: 'reachable, but NOT logged in - log in to chatgpt.com in this Chrome' };
  return { ok: true, detail: 'reachable and logged in' };
}

async function lastTurn(page) {
  return page.evaluate(() => {
    const turns = document.querySelectorAll('[data-talvt-turn-state]');
    let turn = turns[turns.length - 1] || null;
    let state = turn ? turn.getAttribute('data-talvt-turn-state') : null;
    let body = null;
    if (turn) {
      const bodies = turn.querySelectorAll('[data-response-body]');
      body = bodies[bodies.length - 1] || null;
    } else {
      // Fallback for older ChatGPT markup.
      const a = [...document.querySelectorAll('[data-message-author-role="assistant"]')].pop() || null;
      turn = a ? (a.closest('article') || a) : null;
      body = a;
      state = null;
    }
    // An image card in the reply: "Loading images…" placeholder, then a card with Edit / "Share generated image"
    // buttons; the full-resolution file can take minutes to download on slow connections.
    const imageLabel = !!turn && (
      !!(body && body.querySelector('button[aria-label*="generated image" i]'))
      || /loading images/i.test(body ? body.innerText : '')
      || [...turn.querySelectorAll('span,div,p')].some((e) => e.children.length === 0 && /^(image generated|image created)$/i.test((e.textContent || '').trim())));
    // Error bubbles ("Something went wrong ... Try again") can sit outside the normal reply text, with a
    // Retry / Try again / Regenerate button.
    const retryButton = !!turn && [...turn.querySelectorAll('button')]
      .some((b) => /^(retry|try again|regenerate)$/i.test(((b.innerText || '') + ' ' + (b.getAttribute('aria-label') || '')).trim()));
    // Assistant side only: the user's own prompt may contain words like "try again".
    let turnText = turn ? turn.innerText : '';
    if (turn) turn.querySelectorAll('[data-user-message-bubble]').forEach((u) => { turnText = turnText.replace(u.innerText, ''); });
    return { count: turns.length || document.querySelectorAll('[data-message-author-role="assistant"]').length, state, hasBody: !!body, text: body ? body.innerText : '', imageLabel, retryButton, turnText: turnText.slice(-600) };
  });
}

async function typeIntoComposer(page, text) {
  const box = page.locator(COMPOSER).filter({ visible: true }).first();
  await dismissOverlays(page);
  await safeClick(page, box, 'the ChatGPT message box', dismissOverlays);
  await page.keyboard.press('Control+A');
  await page.keyboard.press('Backspace');
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]) await page.keyboard.insertText(lines[i]);
    if (i < lines.length - 1) await page.keyboard.press('Shift+Enter');
  }
  await sleep(500);
  const typed = (await box.innerText()).replace(/\s+/g, ' ');
  const probe = text.replace(/\s+/g, ' ').slice(0, 40);
  if (!typed.includes(probe)) throw new UiError('Could not type the message into ChatGPT');
}

// Clicks ChatGPT's own Retry / Try again / Regenerate button on the last answer. Returns false if there is none.
async function clickRetry(page) {
  const btn = page.locator('[data-talvt-turn-state]').last()
    .getByRole('button', { name: /^(retry|try again|regenerate)$/i }).first();
  if (!(await visible(btn))) return false;
  await safeClick(page, btn, 'ChatGPT "Retry"', dismissOverlays);
  return true;
}

// Sends a message (or, with text = null, presses ChatGPT's Retry button) and waits for the complete answer.
async function ask(page, text, { timeout = 180000, expectImage = false, imageReady = () => false, shouldAbort } = {}) {
  const before = await lastTurn(page);
  if (text === null && (await clickRetry(page))) {
    before.count = -1; // the answer is replaced in place, the turn count does not grow
    // Wait until ChatGPT has really started again, so the old error is not read as a new one.
    await waitUntil(page, async () => {
      const t = await lastTurn(page);
      return t.state === 'in_progress' || !t.retryButton || (await visible(page.locator(STOP)));
    }, { timeout: 20000, label: 'ChatGPT to restart the answer', site: 'ChatGPT', shouldAbort }).catch(() => {});
  } else {
    await typeIntoComposer(page, text === null ? 'Please regenerate the image now, following my instructions above exactly.' : text);
    const send = page.locator(SEND).filter({ visible: true }).first();
    if (await visible(send)) {
      await waitUntil(page, () => send.isEnabled(), { timeout: 10000, label: 'ChatGPT send button', site: 'ChatGPT' });
      await safeClick(page, send, 'the ChatGPT send button', dismissOverlays);
    } else {
      await page.keyboard.press('Enter');
    }
  }
  // Wait for the answer to start.
  await waitUntil(page, async () => {
    const t = await lastTurn(page);
    return t.count > before.count || (t.state === 'in_progress') || (await visible(page.locator(STOP)));
  }, { timeout: 60000, label: 'ChatGPT to start answering', site: 'ChatGPT', shouldAbort });

  let lastSig = '';
  let stableSince = Date.now();
  const result = await waitUntil(page, async () => {
    const t = await lastTurn(page);
    const ready = expectImage && imageReady();
    const errorShown = !ready && !t.imageLabel && (t.retryButton || (!t.text.trim() && TRANSIENT_RE.test(t.turnText)));
    const sig = `${t.text.length}|${t.imageLabel}|${ready}|${errorShown}`;
    if (sig !== lastSig) { lastSig = sig; stableSince = Date.now(); }
    const busy = t.state === 'in_progress' || (await visible(page.locator(STOP)));
    if (busy) return null;
    const stableFor = Date.now() - stableSince;
    if (errorShown && stableFor > 5000) return { ...t, error: true }; // ChatGPT error: caller regenerates
    if (expectImage) {
      if (ready && stableFor > 3000) return t;
      // "Image generated" shown but the file is still loading (slow connections): keep waiting.
      if (!t.imageLabel && t.text && stableFor > 30000) return t; // finished without an image (refusal / "try again" text)
      return null;
    }
    return t.hasBody && t.text.trim() && stableFor > 2500 ? t : null;
  }, { timeout, interval: 1000, label: expectImage ? 'ChatGPT image generation' : 'ChatGPT answer', site: 'ChatGPT', shouldAbort });

  const shown = `${result.text} ${result.turnText || ''}`;
  if (LIMIT_RE.test(shown)) {
    throw new RateLimitError(`ChatGPT image/usage limit reached: ${shown.replace(/\s+/g, ' ').trim().slice(0, 160)}`, limitResetDelay(shown));
  }
  if (!result.error && !expectImage && TRANSIENT_RE.test(result.text) && result.text.length < 300) result.error = true;
  return result;
}

function extractJson(text) {
  const candidates = [...String(text).matchAll(/```(?:json)?\s*([\s\S]*?)```/g)].map((m) => m[1]);
  candidates.push(String(text));
  for (const c of candidates) {
    const s = c.indexOf('{'); const e = c.lastIndexOf('}');
    if (s >= 0 && e > s) {
      const raw = c.slice(s, e + 1).replace(/[“”]/g, '"');
      try { return JSON.parse(raw); } catch (_) { /* try next */ }
    }
  }
  return null;
}

const asList = (v) => (Array.isArray(v) ? v : String(v || '').split(/[,\n]+/)).map((x) => String(x).trim()).filter(Boolean);

function normalizeContent(j) {
  if (!j || typeof j !== 'object') throw new UiError('ChatGPT did not return the expected JSON');
  const str = (v, max) => String(v || '').replace(/\s+/g, ' ').trim().slice(0, max);
  const stripTags = (s) => s.replace(/#[\p{L}\p{N}_]+/gu, '').replace(/\s+/g, ' ').trim();
  const hashtags = [...new Set(asList(j.hashtags).flatMap((t) => t.split(/\s+/))
    .map((t) => `#${t.replace(/^#+/, '').replace(/[^\p{L}\p{N}_]/gu, '')}`)
    .filter((t) => t.length > 2)
    .map((t) => t.toLowerCase()))].slice(0, 8);
  const c = {
    idea: str(j.idea, 400),
    title: stripTags(str(j.title, 200)).slice(0, 85),
    caption: stripTags(str(j.caption, 1500)),
    hashtags,
    music_keywords: asList(j.music_keywords).map((k) => k.slice(0, 40)).slice(0, 4),
    topic_keywords: asList(j.topic_keywords).map((k) => k.slice(0, 40)).slice(0, 6),
  };
  if (!c.idea || !c.caption || c.hashtags.length < 3 || !c.music_keywords.length) {
    throw new UiError('ChatGPT returned incomplete post details (missing description/caption/hashtags/music keywords)');
  }
  if (!c.title) c.title = c.caption.slice(0, 80);
  return c;
}

// Asked AFTER the image exists, in the same chat, so caption and hashtags match the actual image.
function buildDetailsPrompt(recent) {
  const avoid = recent.slice(0, 15).map((r) => `- "${(r.caption || '').slice(0, 90)}" | ${r.hashtags || ''}`).join('\n');
  return [
    'Now write the TikTok photo post details for the image you just created.',
    'If my instructions above say anything about the caption, hashtags, language or style, follow them exactly.',
    avoid ? `Do not repeat these earlier captions or hashtag sets:\n${avoid}` : '',
    '',
    'Reply with ONLY one JSON object inside a ```json code block with exactly these keys:',
    '{"idea": "one sentence describing exactly what the image shows (including any text on it)", "title": "catchy hook, max 80 characters, no hashtags", "caption": "engaging TikTok description, 1-3 short sentences, max 300 characters, no hashtags", "hashtags": ["5 to 8 relevant hashtags popular on TikTok for this topic"], "music_keywords": ["3 short search phrases for the mood/genre of fitting background music, e.g. calm piano"], "topic_keywords": ["3-5 topic keywords"]}',
  ].filter((l) => l !== '').join('\n');
}

function imageType(buf) {
  if (buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png';
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8) return 'jpg';
  if (buf.length > 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  return null;
}

// Pixel size of a PNG / JPEG / WEBP buffer (null if unknown).
function imageSize(buf) {
  const type = imageType(buf);
  try {
    if (type === 'png') return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
    if (type === 'jpg') {
      let i = 2;
      while (i < buf.length - 9) {
        if (buf[i] !== 0xff) { i++; continue; }
        const marker = buf[i + 1];
        const len = buf.readUInt16BE(i + 2);
        if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { w: buf.readUInt16BE(i + 7), h: buf.readUInt16BE(i + 5) };
        i += 2 + len;
      }
    }
    if (type === 'webp') {
      const chunk = buf.toString('ascii', 12, 16);
      if (chunk === 'VP8X') return { w: 1 + buf.readUIntLE(24, 3), h: 1 + buf.readUIntLE(27, 3) };
      if (chunk === 'VP8 ') return { w: buf.readUInt16LE(26) & 0x3fff, h: buf.readUInt16LE(28) & 0x3fff };
      if (chunk === 'VP8L') { const b = buf.readUInt32LE(21); return { w: (b & 0x3fff) + 1, h: ((b >> 14) & 0x3fff) + 1 }; }
    }
  } catch (_) { /* fall through */ }
  return null;
}


const GENERATED_IMAGE_URL = /\/backend-api\/estuary\/content\?id=file_|files\.oaiusercontent\.com\//;

// Sends `message` exactly as given and waits for a generated image. Returns { image, text }, image = null if none.
// The image bytes come from the response the ChatGPT page itself loads to display the picture.
async function sendAndCaptureImage(page, message, { shouldAbort } = {}) {
  const captured = [];
  const onResponse = async (r) => {
    if (!GENERATED_IMAGE_URL.test(r.url()) || !/^image\//.test(r.headers()['content-type'] || '')) return;
    try {
      const body = await r.body();
      const size = imageSize(body);
      if (size && size.w >= 512 && size.h >= 512) captured.push({ body, size });
    } catch (_) { /* response body unavailable */ }
  };
  page.on('response', onResponse);
  let result;
  try {
    result = await ask(page, message, { expectImage: true, imageReady: () => captured.length > 0, timeout: 12 * 60 * 1000, shouldAbort });
  } finally {
    page.off('response', onResponse);
  }
  let best = captured[captured.length - 1] || null; // the final image loads last (after any previews)
  if (!best && result.imageLabel) {
    // Fallback: the image URL is in the page; fetch it from within the page itself.
    const data = await page.evaluate(async () => {
      const urls = document.documentElement.innerHTML.match(/https:\/\/chatgpt\.com\/backend-api\/estuary\/content\?id=file_[^"'\s)<>]+/g) || [];
      const url = urls.length ? urls[urls.length - 1].replace(/&amp;/g, '&') : null;
      if (!url) return null;
      const r = await fetch(url, { credentials: 'include' });
      if (!r.ok) return null;
      const bytes = new Uint8Array(await r.arrayBuffer());
      let s = '';
      for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
      return btoa(s);
    }).catch(() => null);
    if (data) {
      const body = Buffer.from(data, 'base64');
      const size = imageSize(body);
      if (size && size.w >= 512) best = { body, size };
    }
  }
  return { image: best, text: result.text, retryButton: !!result.retryButton, error: !!result.error || (!best && TRANSIENT_RE.test(`${result.text} ${result.turnText || ''}`)) };
}

function saveImage(best, fileBase) {
  const file = `${fileBase}.${imageType(best.body)}`;
  fs.writeFileSync(file, best.body);
  return { file, buffer: best.body, width: best.size.w, height: best.size.h };
}

/**
 * Creates one post:
 *  1. sends the creator's prompt to ChatGPT EXACTLY as written (nothing added or changed) and captures the image,
 *  2. in the same chat asks for title, caption, hashtags and music keywords that match that image.
 * `isDuplicate(details)` returns a reason when the post repeats earlier ones; `isDuplicateImage(buffer)` for images.
 */
async function generatePostWith(d, page, { userPrompt, recent, isDuplicate, isDuplicateImage, fileBase, log, shouldAbort }) {
  await d.openChat(page, { shouldAbort });
  let img = null;
  let lastProblem = '';
  let refusals = 0;
  let retryButton = false;
  for (let attempt = 0; attempt < 6 && !img; attempt++) {
    // First the prompt exactly as written. If no image comes back: regenerate - with ChatGPT's own Retry button
    // when it shows one, otherwise by asking for it - and check again whether an image was created.
    const message = attempt === 0 ? userPrompt : (retryButton ? null : 'Please regenerate the image now, following my instructions above exactly.');
    if (attempt === 0) log.info(`Sending your prompt to ${d.name} exactly as written`);
    else log.warn(`No image (${lastProblem || 'no image in the reply'}) - ${retryButton ? `pressing ${d.name} Retry` : `asking ${d.name} to regenerate the image`} (attempt ${attempt + 1}/6)`);
    if (attempt > 0) {
      // eslint-disable-next-line no-await-in-loop
      await sleep(attempt * 5000);
    }
    // eslint-disable-next-line no-await-in-loop
    const r = await d.sendAndCaptureImage(page, message, { shouldAbort });
    lastProblem = r.error ? `${d.name} showed an error` : r.text.replace(/\s+/g, ' ').trim().slice(0, 80);
    retryButton = r.retryButton;
    if (r.image) {
      if (isDuplicateImage && isDuplicateImage(r.image.body)) {
        log.warn('Image is identical to an earlier post; asking for a new one.');
        // eslint-disable-next-line no-await-in-loop
        const again = await d.sendAndCaptureImage(page, 'This exact image was already posted. Create a new, different image following my instructions above exactly.', { shouldAbort });
        if (again.image && !isDuplicateImage(again.image.body)) img = again.image;
        else throw new UiError(`${d.name} returned an image that was already posted`);
      } else {
        img = r.image;
      }
    } else if (!r.error && REFUSAL_RE.test(r.text) && !TRANSIENT_RE.test(r.text) && ++refusals >= 2) {
      // A real content-policy refusal twice in a row: regenerating again will not help.
      throw new UiError(`${d.name} refused to create the image: ${r.text.replace(/\s+/g, ' ').slice(0, 200)}`);
    }
  }
  if (!img) throw new UiError(`${d.name} did not create an image after 6 tries (${lastProblem})`);
  let saved = saveImage(img, fileBase);
  log.info(`Image saved: ${saved.file} (${saved.width}x${saved.height})`);

  let reply = await d.ask(page, buildDetailsPrompt(recent), { shouldAbort });
  let newImageAsked = false;
  for (let i = 0; i < 4; i++) {
    let details = null;
    let problem = null;
    try {
      details = normalizeContent(extractJson(reply.text));
      problem = isDuplicate(details);
    } catch (e) {
      problem = e.message;
    }
    // A new image was already made for this post: a similar description is expected for a fixed-theme prompt.
    if (!problem || (newImageAsked && /idea is too similar/.test(problem))) return { ...details, image: saved, prompt_sent: userPrompt };
    log.warn(`Post details rejected (${problem}).`);
    if (/idea is too similar/.test(problem) && !newImageAsked) {
      // Same concept as an earlier post: get a different image (same instructions), then new details.
      newImageAsked = true;
      // eslint-disable-next-line no-await-in-loop
      const again = await d.sendAndCaptureImage(page, 'This is too similar to something I already posted. Create a new, clearly different image following my original instructions above exactly.', { shouldAbort });
      if (!again.image) throw new UiError(`${d.name} did not create a replacement image`);
      fs.rmSync(saved.file, { force: true });
      saved = saveImage(again.image, fileBase);
      // eslint-disable-next-line no-await-in-loop
      reply = await d.ask(page, buildDetailsPrompt(recent), { shouldAbort });
      continue;
    }
    // eslint-disable-next-line no-await-in-loop
    reply = await d.ask(page, `That does not work: ${problem}. Write different details for the same image. Reply with ONLY the JSON object in a \`\`\`json code block, same keys as before.`, { shouldAbort });
  }
  throw new UiError(`${d.name} kept returning invalid or repeated post details`);
}

// The ChatGPT implementation of the shared post flow (Gemini provides its own driver in gemini.js).
const CHATGPT_DRIVER = { name: 'ChatGPT', openChat, sendAndCaptureImage, ask };
const generatePost = (page, opts) => generatePostWith(CHATGPT_DRIVER, page, opts);

module.exports = { generatePostWith, saveImage, limitResetDelay, checkChatGPT, openChat, generatePost, extractJson, normalizeContent, buildDetailsPrompt, imageType, imageSize };
