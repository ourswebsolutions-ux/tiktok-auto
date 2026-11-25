'use strict';
// ChatGPT.com automation (runs inside the user's own logged-in Chrome session).
// Selectors verified against chatgpt.com on 2026-11-25:
//   composer:  .ProseMirror[contenteditable=true] (role=textbox)
//   send:      button[aria-label="Send"]
//   turn:      [data-talvt-turn-state]  ("in_progress" while answering, "complete" when done)
//   reply:     [data-response-body] inside the turn
// Older/alternative markup is kept as a fallback.

const fs = require('fs');
const { NeedsHumanError, RateLimitError, UiError, sleep, waitUntil, visible, detectChallenge } = require('./util');

// A regular chat is required: ChatGPT does not allow image generation in temporary chats.
const CHAT_URL = 'https://chatgpt.com/';
const COMPOSER = '.ProseMirror[contenteditable="true"], #prompt-textarea, textarea[name="prompt-textarea"]';
const SEND = 'button[aria-label="Send"], button[data-testid="send-button"], #composer-submit-button, button[aria-label="Send prompt"]';
const STOP = 'button[aria-label="Stop"], button[data-testid="stop-button"], button[aria-label="Stop streaming"]';
const LIMIT_RE = /(you['’]ve|you have) (hit|reached) (the|your)[^.]{0,60}limit|limit (resets|will reset)|image generation (is )?(temporarily )?(unavailable|limited)|you['’]ve reached the current usage cap|too many requests|try again (later|after|in \d)/i;
const REFUSAL_RE = /(i can['’]t|i cannot|i['’]m unable to|i am unable to|unable to) (help|create|generate|make|fulfill)|violates? (our|the) (content )?polic/i;

async function ensureLoggedIn(page) {
  const loginBtn = page.getByRole('button', { name: /^log in$/i }).or(page.getByRole('link', { name: /^log in$/i }));
  if (await visible(loginBtn)) {
    throw new NeedsHumanError('ChatGPT is not logged in in your Chrome profile. Please log in to chatgpt.com in Chrome.', { site: 'ChatGPT', page });
  }
}

async function openChat(page, opts = {}) {
  await page.goto(CHAT_URL, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await waitUntil(page, () => visible(page.locator(COMPOSER)), { timeout: 60000, label: 'ChatGPT message box', site: 'ChatGPT', shouldAbort: opts.shouldAbort });
  await sleep(1500);
  await ensureLoggedIn(page);
}

// Read-only check used by "Check Chrome" and the startup check. Sends nothing.
async function checkChatGPT(page) {
  await page.goto('https://chatgpt.com/', { waitUntil: 'domcontentloaded', timeout: 90000 });
  try {
    await waitUntil(page, () => visible(page.locator(COMPOSER)), { timeout: 45000, label: 'ChatGPT message box', site: 'ChatGPT' });
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
    return { count: turns.length || document.querySelectorAll('[data-message-author-role="assistant"]').length, state, hasBody: !!body, text: body ? body.innerText : '', imageLabel };
  });
}

async function typeIntoComposer(page, text) {
  const box = page.locator(COMPOSER).first();
  await box.click();
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

// Sends a message and waits for the complete answer.
async function ask(page, text, { timeout = 180000, expectImage = false, imageReady = () => false, shouldAbort } = {}) {
  const before = await lastTurn(page);
  await typeIntoComposer(page, text);
  const send = page.locator(SEND).first();
  if (await visible(send)) {
    await waitUntil(page, () => send.isEnabled(), { timeout: 10000, label: 'ChatGPT send button', site: 'ChatGPT' });
    await send.click();
  } else {
    await page.keyboard.press('Enter');
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
    const sig = `${t.text.length}|${t.imageLabel}|${ready}`;
    if (sig !== lastSig) { lastSig = sig; stableSince = Date.now(); }
    const busy = t.state === 'in_progress' || (await visible(page.locator(STOP)));
    if (busy) return null;
    const stableFor = Date.now() - stableSince;
    if (expectImage) {
      if (ready && stableFor > 3000) return t;
      // "Image generated" shown but the file is still loading (slow connections): keep waiting.
      if (!t.imageLabel && t.text && stableFor > 30000) return t; // finished without an image (refusal / limit)
      return null;
    }
    return t.hasBody && t.text.trim() && stableFor > 2500 ? t : null;
  }, { timeout, interval: 1000, label: expectImage ? 'ChatGPT image generation' : 'ChatGPT answer', site: 'ChatGPT', shouldAbort });

  if (LIMIT_RE.test(result.text)) {
    throw new RateLimitError(`ChatGPT usage limit reached: ${result.text.replace(/\s+/g, ' ').slice(0, 160)}`, 90 * 60 * 1000);
  }
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
    image_prompt: str(j.image_prompt, 3000),
    music_keywords: asList(j.music_keywords).map((k) => k.slice(0, 40)).slice(0, 4),
    topic_keywords: asList(j.topic_keywords).map((k) => k.slice(0, 40)).slice(0, 6),
  };
  if (!c.idea || !c.caption || c.image_prompt.length < 30 || c.hashtags.length < 3 || !c.music_keywords.length) {
    throw new UiError('ChatGPT returned incomplete content (missing idea/caption/image prompt/hashtags/music keywords)');
  }
  if (!c.title) c.title = c.caption.slice(0, 80);
  return c;
}

function buildContentPrompt(userPrompt, recent) {
  const avoid = recent.slice(0, 20).map((r) => `- ${r.idea || ''} | "${(r.caption || '').slice(0, 80)}" | ${r.hashtags || ''}`).join('\n');
  return [
    'You are a TikTok content strategist. Create ONE new TikTok photo post (a single AI-generated image with a caption) based on the creator instructions below.',
    '',
    'CREATOR INSTRUCTIONS:',
    userPrompt.trim(),
    '',
    avoid ? `Previously used ideas (yours must be clearly DIFFERENT in topic angle, wording, visual concept and hashtag set):\n${avoid}` : 'This is the first post.',
    '',
    'Requirements:',
    '- A fresh, specific, engaging idea that fits the instructions.',
    '- "image_prompt": a detailed image-generation prompt (subject, setting, style, lighting, colors, composition), vertical 9:16 portrait format, no text, letters, watermarks or logos in the image.',
    '- "title": a catchy hook of at most 80 characters, no hashtags.',
    '- "caption": an engaging TikTok description of 1-3 short sentences (max 300 characters), may include emojis, NO hashtags.',
    '- "hashtags": 5 to 8 relevant hashtags that are currently popular on TikTok for this topic, mixing broad and niche tags.',
    '- "music_keywords": 3 short search phrases (1-3 words each) describing the mood/genre/theme of background music that fits this post, for searching TikTok\'s sound library (e.g. "calm piano", "epic motivation").',
    '- "topic_keywords": 3-5 keywords describing the topic.',
    '',
    'Reply with ONLY one JSON object inside a ```json code block, with exactly these keys:',
    '{"idea": "", "title": "", "caption": "", "hashtags": [], "image_prompt": "", "music_keywords": [], "topic_keywords": []}',
  ].join('\n');
}

// Generates text content. `isDuplicate(content)` returns a reason string when the result repeats earlier posts.
async function generateContent(page, { userPrompt, recent, isDuplicate, log, shouldAbort }) {
  await openChat(page, { shouldAbort });
  let reply = await ask(page, buildContentPrompt(userPrompt, recent), { shouldAbort });
  for (let i = 0; i < 4; i++) {
    let content = null;
    let problem = null;
    try {
      content = normalizeContent(extractJson(reply.text));
      problem = isDuplicate(content);
    } catch (e) {
      problem = e.message;
    }
    if (!problem) return content;
    log.warn(`ChatGPT content rejected (${problem}); asking for a different one.`);
    // eslint-disable-next-line no-await-in-loop
    reply = await ask(page, `That does not work: ${problem}. Create a completely different idea with a different angle, caption and hashtags. Reply with ONLY the JSON object in a \`\`\`json code block, same keys as before.`, { shouldAbort });
  }
  throw new UiError('ChatGPT kept returning invalid or repeated content');
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

// Asks ChatGPT (same chat) to generate the image and saves it. Returns { file, buffer, width, height }.
// The image is taken from the response the ChatGPT page itself loads to display the picture.
async function generateImage(page, { imagePrompt, fileBase, shouldAbort, retryNote }) {
  const msg = [
    retryNote || 'Now generate the image for this post using ChatGPT image generation.',
    'Vertical 9:16 portrait aspect ratio. No text, letters, watermarks or logos in the image.',
    '',
    `Image prompt: ${imagePrompt}`,
  ].join('\n');
  const captured = [];
  const onResponse = async (r) => {
    if (!GENERATED_IMAGE_URL.test(r.url()) || !/^image\//.test(r.headers()['content-type'] || '')) return;
    try {
      const body = await r.body();
      const size = imageSize(body);
      if (size && size.w >= 512 && size.h >= 512) captured.push({ url: r.url(), body, size });
    } catch (_) { /* response body unavailable */ }
  };
  page.on('response', onResponse);
  let result;
  try {
    result = await ask(page, msg, { expectImage: true, imageReady: () => captured.length > 0, timeout: 12 * 60 * 1000, shouldAbort });
  } finally {
    page.off('response', onResponse);
  }
  let best = captured[captured.length - 1] || null; // final image is loaded last (after any previews)

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
  if (!best) {
    const t = result.text.replace(/\s+/g, ' ').slice(0, 200);
    if (REFUSAL_RE.test(result.text)) throw new UiError(`ChatGPT refused to create the image: ${t}`);
    throw new UiError(`ChatGPT did not produce a downloadable image: ${t}`);
  }
  const file = `${fileBase}.${imageType(best.body)}`;
  fs.writeFileSync(file, best.body);
  return { file, buffer: best.body, width: best.size.w, height: best.size.h };
}

module.exports = { checkChatGPT, openChat, generateContent, generateImage, extractJson, normalizeContent, buildContentPrompt, imageType, imageSize };
