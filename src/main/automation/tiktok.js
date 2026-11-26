'use strict';
// TikTok Studio automation (runs inside the user's own logged-in Chrome session).
// Verified against tiktok.com/tiktokstudio on 2026-11-25:
//   upload page has "Videos | Photos" tabs; Photos -> input[type=file][accept*=image]
//   editor: title input[placeholder="Add a catchy title"], description Draft.js editor inside
//           [data-e2e=caption_container], "Add sound" button, [data-e2e=aigc_container] switch, "Post" button
//   sound picker: .TUXModal-overlay with input[placeholder="Search sounds"], rows [class*=MusicPanelMusicItem]
//           each with a "Use" control. TikTok's own sound data (incl. user_count = number of videos using
//           the sound) is read passively from the responses the picker itself loads.

const { NeedsHumanError, UiError, sleep, normalize, waitUntil, visible, detectChallenge, wordSet, safeClick } = require('./util');

const UPLOAD_URL = 'https://www.tiktok.com/tiktokstudio/upload?from=webapp';
const MIN_SOUND_USES = 10000; // a sound must be visibly used in at least this many videos to count as popular
const SITE = 'TikTok';

const fmtCount = (n) => (n >= 1e9 ? `${(n / 1e9).toFixed(1)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : String(n));

function assertNotLoginPage(page) {
  if (/tiktok\.com\/login|\/login\?/i.test(page.url())) {
    throw new NeedsHumanError('TikTok is not logged in in your Chrome profile. Please log in to tiktok.com in Chrome.', { site: SITE, page });
  }
}

async function openUploader(page, shouldAbort) {
  await page.goto(UPLOAD_URL, { waitUntil: 'commit', timeout: 90000 });
  // TikTok Studio can take 30-60 s to load on slow connections.
  await waitUntil(page, async () => {
    assertNotLoginPage(page);
    return (await page.locator('input[type=file]').count()) > 0;
  }, { timeout: 180000, label: 'TikTok upload page', site: SITE, shouldAbort });
}

// Read-only check: loads the uploader and confirms we are logged in. Uploads nothing.
async function checkTikTok(page) {
  try {
    await openUploader(page);
    return { ok: true, detail: 'TikTok Studio upload page reachable and logged in' };
  } catch (e) {
    if (e instanceof NeedsHumanError) return { ok: false, detail: e.message };
    const ch = await detectChallenge(page);
    return { ok: false, detail: ch ? `${ch} - solve it in Chrome` : e.message };
  }
}

async function dismissInfoDialogs(page) {
  for (const name of [/^got it$/i, /^not now$/i, /^ok$/i, /^skip$/i]) {
    const b = page.locator('.TUXModal-overlay, [role=dialog]').getByRole('button', { name });
    // eslint-disable-next-line no-await-in-loop
    if (await visible(b)) { await b.first().click().catch(() => {}); await sleep(800); }
  }
}

// Click with popup handling and a readable error message naming the element.
const tclick = (page, locator, label) => safeClick(page, locator, label, dismissInfoDialogs);

async function uploadPhoto(page, imagePath, shouldAbort) {
  const photosTab = page.getByText('Photos', { exact: true }).first();
  await waitUntil(page, () => visible(photosTab), { timeout: 30000, label: 'Photos tab on the upload page', site: SITE, shouldAbort });
  await tclick(page, photosTab, 'TikTok "Photos" tab');
  const input = page.locator('input[type=file][accept*="image"]').first();
  await waitUntil(page, async () => (await page.locator('input[type=file][accept*="image"]').count()) > 0, { timeout: 20000, label: 'photo file input', site: SITE });
  await input.setInputFiles(imagePath);
  await waitUntil(page, async () => (await visible(page.getByRole('button', { name: /add sound/i })))
    && (await visible(page.locator('[data-e2e=caption_container]'))), { timeout: 120000, label: 'TikTok post editor after photo upload', site: SITE, shouldAbort });
  await waitUntil(page, () => visible(page.getByText(/1 photo uploaded/i)), { timeout: 60000, label: '"1 photo uploaded" confirmation', site: SITE });
  await sleep(1500);
  await dismissInfoDialogs(page);
}

// ---------------- sound selection ----------------

function collectMusic(json, source, into) {
  const list = Array.isArray(json && json.data) ? json.data.map((d) => d.music_info || d)
    : Array.isArray(json && json.music_list) ? json.music_list : [];
  list.forEach((m, idx) => {
    if (!m || !m.title) return;
    const id = String(m.id_str || m.id || `${m.title}|${m.author}`);
    const prev = into.get(id);
    const tags = [...(m.tag_list || []), ...(m.tag_list_v2 || [])].map((t) => (typeof t === 'string' ? t : (t && (t.name || t.tag_name)) || '')).join(' ');
    const entry = prev || {
      id, title: String(m.title), author: String(m.author || m.owner_nickname || ''), userCount: Number(m.user_count) || 0,
      duration: Number(m.duration) || 0, desc: `${m.album || ''} ${m.search_music_desc || ''} ${tags}`,
      shootingAllowed: m.is_shooting_allow !== false, reusable: m.can_not_reuse !== true, sources: [],
    };
    entry.sources.push({ source, position: idx });
    into.set(id, entry);
  });
}

function rankSounds(candidates, { keywords, topicKeywords, recentSounds }) {
  const want = wordSet([...keywords, ...topicKeywords].join(' '));
  const recent = new Set((recentSounds || []).map((s) => normalize(s)));
  return [...candidates.values()]
    .filter((c) => c.shootingAllowed && c.reusable && c.userCount >= MIN_SOUND_USES)
    .filter((c) => !recent.has(normalize(`${c.title} - ${c.author}`)))
    .map((c) => {
      const words = wordSet(`${c.title} ${c.author} ${c.desc}`);
      let overlap = 0; for (const w of want) if (words.has(w)) overlap++;
      const searchHits = c.sources.filter((s) => s.source.startsWith('search:')).length;
      const topRank = Math.min(...c.sources.map((s) => s.position));
      const recommended = c.sources.some((s) => s.source === 'recommended-for-this-photo');
      // Relevance first (TikTok search match for our topic keywords, TikTok's own photo-based recommendation,
      // keyword overlap), then verified popularity (number of videos using the sound).
      const relevance = searchHits * 2 + (recommended ? 1.5 : 0) + overlap * 1.5 + (topRank < 5 ? 1 : 0);
      return { ...c, relevance, score: relevance * 2 + Math.log10(c.userCount) };
    })
    .filter((c) => c.relevance > 0)
    .sort((a, b) => b.score - a.score);
}

async function soundPanel(page) {
  const panel = page.locator('.TUXModal-overlay').filter({ has: page.getByPlaceholder('Search sounds') });
  return panel;
}

async function openSoundPanel(page) {
  const panel = await soundPanel(page);
  if (await visible(panel)) return panel;
  const btn = page.getByRole('button', { name: /^(\+\s*)?add sound$/i }).or(page.getByRole('button', { name: /^replace$/i }));
  await tclick(page, btn.first(), 'TikTok "Add sound"');
  await waitUntil(page, () => visible(panel), { timeout: 20000, label: 'TikTok sound picker', site: SITE });
  return panel;
}

async function closeSoundPanel(page) {
  const panel = await soundPanel(page);
  if (!(await visible(panel))) return;
  await page.keyboard.press('Escape').catch(() => {});
  await sleep(800);
  if (await visible(panel)) {
    const close = panel.locator('button[aria-label*="close" i], [class*="close" i]').first();
    await close.click().catch(() => {});
    await sleep(800);
  }
}

async function searchSounds(page, panel, query) {
  const input = panel.getByPlaceholder('Search sounds');
  await input.fill('');
  await input.fill(query);
  await input.press('Enter');
  await sleep(4500);
}

async function selectedSoundText(page) {
  return page.evaluate(() => {
    const btn = [...document.querySelectorAll('button')].find((b) => /^replace$/i.test((b.innerText || '').trim()));
    if (!btn) return '';
    let el = btn;
    for (let i = 0; i < 4 && el.parentElement; i++) el = el.parentElement;
    return el.innerText || '';
  });
}

async function trySelectSound(page, cand, log) {
  const panel = await openSoundPanel(page);
  await searchSounds(page, panel, `${cand.title} ${cand.author}`.slice(0, 80));
  const rows = panel.locator('[class*="MusicPanelMusicItem"]').filter({ hasText: cand.title });
  const n = await rows.count();
  for (let i = 0; i < n; i++) {
    const row = rows.nth(i);
    // eslint-disable-next-line no-await-in-loop
    const text = (await row.innerText().catch(() => '')) || '';
    if (!normalize(text).includes(normalize(cand.title)) || (cand.author && !normalize(text).includes(normalize(cand.author)))) continue;
    // eslint-disable-next-line no-await-in-loop
    await row.hover().catch(() => {});
    const use = row.getByText('Use', { exact: true }).first();
    // eslint-disable-next-line no-await-in-loop
    if (!(await visible(use))) continue;
    // eslint-disable-next-line no-await-in-loop
    try { await tclick(page, use, `"Use" for sound "${cand.title}"`); } catch (e) { log.warn(e.message); return false; }
    // eslint-disable-next-line no-await-in-loop
    await sleep(2500);
    // eslint-disable-next-line no-await-in-loop
    const chosen = await selectedSoundText(page);
    if (normalize(chosen).includes(normalize(cand.title))) return true;
    log.warn(`Sound "${cand.title}" did not show as selected after clicking Use.`);
    return false;
  }
  log.warn(`Sound "${cand.title}" by ${cand.author} not found/available in the sound picker.`);
  return false;
}

// Picks the most relevant sound with verifiable popularity and attaches it. Never picks at random:
// if nothing relevant with visible popularity can be attached, the post goes out without an added sound.
async function attachSound(page, { keywords, topicKeywords, recentSounds, log }) {
  const candidates = new Map();
  const onResponse = async (r) => {
    const u = r.url();
    let source = null;
    if (u.includes('/api/search/music/full')) {
      try { source = `search:${new URL(u).searchParams.get('keyword') || ''}`; } catch (_) { source = 'search:'; }
    } else if (u.includes('/music/recommend/by/video')) source = 'recommended-for-this-photo';
    if (!source) return;
    try { collectMusic(await r.json(), source, candidates); } catch (_) { /* ignore non-JSON */ }
  };
  page.on('response', onResponse);
  try {
    const panel = await openSoundPanel(page);
    await sleep(4000); // TikTok loads sounds recommended for the uploaded photo
    for (const kw of keywords.slice(0, 3)) {
      // eslint-disable-next-line no-await-in-loop
      await searchSounds(page, panel, kw);
    }
    const ranked = rankSounds(candidates, { keywords, topicKeywords, recentSounds });
    log.info(`Sound candidates with verified popularity: ${ranked.length} (of ${candidates.size} seen).`);
    for (const cand of ranked.slice(0, 5)) {
      log.info(`Trying sound "${cand.title}" by ${cand.author} (used in ${fmtCount(cand.userCount)} videos, relevance ${cand.relevance.toFixed(1)}).`);
      // eslint-disable-next-line no-await-in-loop
      if (await trySelectSound(page, cand, log)) {
        const via = cand.sources.some((s) => s.source.startsWith('search:')) ? `TikTok search for "${cand.sources.find((s) => s.source.startsWith('search:')).source.slice(7)}"` : 'TikTok recommendation for this photo';
        return {
          title: `${cand.title} - ${cand.author}`,
          evidence: `Used in ${fmtCount(cand.userCount)} TikTok videos (TikTok sound data); matched via ${via}`,
        };
      }
    }
    return null;
  } finally {
    page.off('response', onResponse);
    await closeSoundPanel(page);
  }
}

// ---------------- caption, label, publish ----------------

async function setTitle(page, title) {
  const input = page.locator('input[placeholder="Add a catchy title"]').first();
  if (!(await visible(input))) return false; // some accounts/videos have no separate title
  await input.fill(title);
  await sleep(400);
  if ((await input.inputValue()).trim() !== title.trim()) throw new UiError('Post title did not stick in TikTok editor');
  return true;
}

async function setDescription(page, caption, hashtags) {
  const editor = page.locator('[data-e2e=caption_container] [contenteditable="true"]').first();
  await waitUntil(page, () => visible(editor), { timeout: 20000, label: 'TikTok description editor', site: SITE });
  await tclick(page, editor, 'TikTok description box');
  await page.keyboard.press('Control+A');
  await page.keyboard.press('Backspace');
  await page.keyboard.type(caption, { delay: 8 });
  await page.keyboard.type(' ', { delay: 8 });
  for (const tag of hashtags) {
    await page.keyboard.type(tag, { delay: 25 });
    await sleep(700);
    await page.keyboard.type(' ', { delay: 10 }); // space closes TikTok's hashtag suggestion list
    await sleep(300);
  }
  await sleep(1000);
  const actual = normalize(await editor.innerText());
  const expected = normalize(`${caption} ${hashtags.join(' ')}`);
  if (actual !== expected) {
    throw new UiError(`Description in TikTok editor does not match the generated caption (got "${actual.slice(0, 80)}...")`);
  }
}

async function enableAiLabel(page, log) {
  const container = page.locator('[data-e2e=aigc_container]').first();
  if (!(await visible(container))) {
    const more = page.getByText(/^show more$/i).first();
    if (await visible(more)) { await tclick(page, more, 'TikTok "Show more"'); await sleep(1000); }
  }
  if (!(await visible(container))) { log.warn('AI-generated content switch not found on this account.'); return false; }
  const sw = container.locator('[aria-checked]').first();
  if ((await sw.getAttribute('aria-checked')) !== 'true') {
    await tclick(page, sw, 'TikTok "AI-generated content" switch');
    await sleep(1200);
    const confirm = page.locator('.TUXModal-overlay, [role=dialog]').getByRole('button', { name: /^(turn on|confirm|ok|got it)$/i });
    if (await visible(confirm)) { await confirm.first().click(); await sleep(1000); }
  }
  const on = (await sw.getAttribute('aria-checked')) === 'true';
  if (!on) log.warn('Could not switch on the "AI-generated content" label.');
  return on;
}

async function ensurePostNow(page) {
  const now = page.getByText('Now', { exact: true }).first();
  if (await visible(now)) await now.click().catch(() => {});
}

// ---------- TikTok native scheduling ("When to post: Schedule") ----------
// Verified 2026-11-26: radio input[value=schedule] in [data-e2e=schedule_container]; first use may show
// "Allow your video to be saved for scheduled posting?" (Cancel / Allow); then .scheduled-picker with
// [aria-label="Select date"] (DatePicker__panel, day buttons labelled "Thursday, November 26th, 2026")
// and [aria-label="Select time"] (two TimePicker__column wheels: hours 00-23, minutes in 5-minute steps).
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const pad2 = (n) => String(n).padStart(2, '0');
const ordinal = (d) => d + ((d % 100 >= 11 && d % 100 <= 13) ? 'th' : (['th', 'st', 'nd', 'rd'][d % 10] || 'th'));
const SCHEDULE_STEP_MS = 5 * 60 * 1000;
const MIN_SCHEDULE_LEAD_MS = 20 * 60 * 1000; // TikTok needs at least ~15 minutes; keep a safety margin

// TikTok's time picker uses 5-minute steps: round up and keep the minimum lead time.
function tiktokScheduleTime(slotMs, nowMs = Date.now()) {
  const t = Math.max(slotMs, nowMs + MIN_SCHEDULE_LEAD_MS);
  return Math.ceil(t / SCHEDULE_STEP_MS) * SCHEDULE_STEP_MS;
}

async function pickerValue(page, label) {
  const loc = page.locator('.scheduled-picker [aria-label="' + label + '"] .Picker__value').first();
  return (await loc.innerText().catch(() => '')).trim();
}

// "(GMT+5) Local Time" -> +300 minutes; "(GMT) ..." -> 0; null if no offset is shown.
function tzOffsetMinutes(tzText) {
  const m = String(tzText || '').match(/GMT(?:\s*([+-])\s*(\d{1,2})(?::?(\d{2}))?)?\)/i);
  if (!m) return null;
  if (!m[1]) return 0;
  return (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3] || 0));
}

// Wall-clock date/time of an instant in TikTok's schedule timezone (falls back to this computer's timezone).
function wallClock(ms, offsetMin) {
  if (offsetMin === null || offsetMin === undefined) {
    const x = new Date(ms);
    return { y: x.getFullYear(), mo: x.getMonth(), d: x.getDate(), h: x.getHours(), mi: x.getMinutes() };
  }
  const x = new Date(ms + offsetMin * 60000);
  return { y: x.getUTCFullYear(), mo: x.getUTCMonth(), d: x.getUTCDate(), h: x.getUTCHours(), mi: x.getUTCMinutes() };
}

async function isDisabled(locator) {
  return locator.evaluate((e) => !!(e.disabled || e.getAttribute('aria-disabled') === 'true' || /disabled/i.test(String(e.className)))).catch(() => false);
}

async function setSchedule(page, whenMs, log) {
  const container = page.locator('[data-e2e=schedule_container]');
  const radio = container.locator('input[value=schedule]').first();
  await radio.scrollIntoViewIfNeeded().catch(() => {});
  await tclick(page, container.getByText('Schedule', { exact: true }).first(), 'TikTok "Schedule" option');
  await sleep(1500);
  // One-time TikTok consent for scheduled posts.
  const allow = page.locator('.TUXModal-overlay, [role=dialog]').getByRole('button', { name: /^allow$/i });
  if (await visible(allow)) { await allow.first().click(); await sleep(1500); }
  if (!(await radio.isChecked())) await radio.check({ force: true });
  await waitUntil(page, () => visible(page.locator('.scheduled-picker [aria-label="Select date"]')),
    { timeout: 15000, label: 'TikTok schedule date/time pickers', site: SITE });

  // TikTok's schedule clock can differ from this computer's clock (account/browser timezone): convert the post
  // time into the timezone TikTok shows, e.g. "(GMT+5) Local Time".
  const tz = await page.locator('.scheduled-picker .timezone-select input').first().inputValue().catch(() => '');
  const offset = tzOffsetMinutes(tz);
  const w = wallClock(whenMs, offset);
  const d = { getFullYear: () => w.y, getMonth: () => w.mo, getDate: () => w.d, getHours: () => w.h, getMinutes: () => w.mi };
  if (offset !== null && offset !== -new Date(whenMs).getTimezoneOffset()) {
    log.warn('TikTok schedule timezone "' + tz + '" differs from this computer\'s timezone - converting the time.');
  }

  // Date
  const wantDate = MONTHS[d.getMonth()].slice(0, 3) + ' ' + d.getDate() + ', ' + d.getFullYear();
  if ((await pickerValue(page, 'Select date')) !== wantDate) {
    await tclick(page, page.locator('.scheduled-picker [aria-label="Select date"]'), 'TikTok schedule date');
    const panel = page.locator('.DatePicker__panel').first();
    await waitUntil(page, () => visible(panel), { timeout: 10000, label: 'TikTok date calendar', site: SITE });
    const dayLabel = MONTHS[d.getMonth()] + ' ' + ordinal(d.getDate()) + ', ' + d.getFullYear();
    const dayBtn = panel.locator('button[aria-label$="' + dayLabel + '"]').first();
    for (let i = 0; i < 2 && !(await visible(dayBtn)); i++) {
      // eslint-disable-next-line no-await-in-loop
      await panel.getByRole('button', { name: 'Next month' }).click().catch(() => {});
      // eslint-disable-next-line no-await-in-loop
      await sleep(600);
    }
    if (!(await visible(dayBtn))) throw new UiError('TikTok calendar does not offer ' + dayLabel);
    if ((await dayBtn.isDisabled().catch(() => false)) || (await dayBtn.getAttribute('aria-disabled')) === 'true') {
      throw new UiError('TikTok does not allow scheduling on ' + dayLabel + ' (outside TikTok\'s scheduling window)');
    }
    await tclick(page, dayBtn, 'TikTok calendar day ' + dayLabel);
    await sleep(800);
    if (await visible(panel)) await page.keyboard.press('Escape').catch(() => {});
  }
  const gotDate = await pickerValue(page, 'Select date');
  if (gotDate !== wantDate) throw new UiError('TikTok schedule date is "' + gotDate + '", expected "' + wantDate + '"');

  // Time
  const hh = pad2(d.getHours());
  const mm = pad2(d.getMinutes());
  const wantTime = hh + ':' + mm;
  for (let tryNo = 0; tryNo < 3 && (await pickerValue(page, 'Select time')) !== wantTime; tryNo++) {
    await tclick(page, page.locator('.scheduled-picker [aria-label="Select time"]'), 'TikTok schedule time');
    const cols = page.locator('.TimePicker__column');
    await waitUntil(page, async () => (await cols.count()) >= 2 && (await visible(cols.first())),
      { timeout: 10000, label: 'TikTok time picker', site: SITE });
    const hourItem = cols.nth(0).locator('.TimePicker__item').filter({ hasText: new RegExp('^' + hh + '$') }).first();
    const minItem = cols.nth(1).locator('.TimePicker__item').filter({ hasText: new RegExp('^' + mm + '$') }).first();
    if (await isDisabled(hourItem)) {
      throw new UiError('TikTok does not allow ' + wantTime + ' on ' + wantDate + ' (TikTok clock: ' + (tz || 'unknown timezone') + ')');
    }
    // Wheel pickers: bring the item into view first, then click it.
    await hourItem.scrollIntoViewIfNeeded().catch(() => {});
    await sleep(400);
    await tclick(page, hourItem, 'TikTok hour ' + hh);
    await sleep(600);
    await minItem.scrollIntoViewIfNeeded().catch(() => {});
    await sleep(400);
    await tclick(page, minItem, 'TikTok minute ' + mm);
    await sleep(800);
    if (await visible(cols.first())) await page.keyboard.press('Escape').catch(() => {});
    await sleep(500);
  }
  const gotTime = await pickerValue(page, 'Select time');
  if (gotTime !== wantTime) throw new UiError('TikTok schedule time is "' + gotTime + '", expected "' + wantTime + '" (TikTok clock: ' + (tz || 'unknown timezone') + ')');
  if (!(await radio.isChecked())) throw new UiError('TikTok "Schedule" option did not stay selected');
  return wantDate + ' ' + wantTime;
}

async function scheduleStillMatches(page, scheduledFor) {
  if (!scheduledFor) return true;
  return (await pickerValue(page, 'Select date')) + ' ' + (await pickerValue(page, 'Select time')) === scheduledFor;
}

const SUCCESS_RE = /(your (post|video|photo)s? (has been|have been|is being|was|were) (posted|published|uploaded|shared|scheduled))|(posted|published|uploaded|scheduled) successfully|manage your posts|view (your )?post/i;
const FAIL_RE = /(couldn['’]t|could not|failed to|unable to) (post|publish|upload)|something went wrong|(posting|uploading) too (fast|frequently|often)|reached (the|your) (daily )?(post|upload)ing? limit|try again later/i;

async function clickPostAndConfirm(page, shouldAbort, buttonName = 'Post') {
  // With "Schedule" selected TikTok renames the Post button to "Schedule" (the radio label is not a button).
  const postBtn = page.getByRole('button', { name: buttonName, exact: true }).last();
  await waitUntil(page, async () => (await visible(postBtn)) && (await postBtn.isEnabled()) && (await postBtn.getAttribute('aria-disabled')) !== 'true',
    { timeout: 60000, label: 'enabled ' + buttonName + ' button', site: SITE, shouldAbort });
  const startUrl = page.url();
  await tclick(page, postBtn, 'TikTok "' + buttonName + '" button');
  const res = await waitUntil(page, async () => {
    const confirm = page.locator('.TUXModal-overlay, [role=dialog]').getByRole('button', { name: /^(post now|post anyway|continue|confirm)$/i });
    if (await visible(confirm)) { await confirm.first().click().catch(() => {}); return null; }
    const text = await page.evaluate(() => document.body.innerText).catch(() => '');
    if (FAIL_RE.test(text)) return { ok: false, message: (text.match(FAIL_RE) || [''])[0] };
    if (page.url() !== startUrl && /tiktokstudio\/(content|post)/.test(page.url())) return { ok: true, signal: 'redirected to Posts page' };
    if (SUCCESS_RE.test(text)) return { ok: true, signal: (text.match(SUCCESS_RE) || [''])[0] };
    return null;
  }, { timeout: 180000, interval: 1000, label: 'TikTok publish confirmation', site: SITE }).catch((e) => ({ ok: false, message: e.message, timeout: true }));
  return res;
}

/**
 * Full publish flow for one photo post.
 * hooks.beforePost() is called right before clicking Post (used to persist the "posting" state).
 * scheduleAt (ms): when set, the post is scheduled with TikTok's own "Schedule" option instead of posted now.
 * Returns { published: boolean, unverified?: boolean, signal, sound, scheduledFor? }.
 */
async function publishPhotoPost(page, post, { log, shouldAbort, recentSounds, beforePost, onProgress, scheduleAt = null }) {
  onProgress('Opening TikTok Studio');
  await openUploader(page, shouldAbort);
  onProgress('Uploading image to TikTok');
  await uploadPhoto(page, post.image_path, shouldAbort);

  onProgress('Selecting a relevant popular sound');
  let sound = null;
  try {
    sound = await attachSound(page, {
      keywords: JSON.parse(post.music_keywords || '[]'), topicKeywords: JSON.parse(post.topic_keywords || '[]'), recentSounds, log,
    });
  } catch (e) {
    if (e instanceof NeedsHumanError) throw e;
    log.warn(`Sound selection failed: ${e.message}`);
  }
  if (!sound) log.warn('No relevant sound with verifiable popularity could be attached; posting without an added sound.');

  onProgress('Entering caption and hashtags');
  const hashtags = JSON.parse(post.hashtags || '[]');
  await setTitle(page, post.title || '');
  await setDescription(page, post.caption, hashtags);
  await enableAiLabel(page, log);
  let scheduledFor = null;
  if (scheduleAt) {
    onProgress('Setting TikTok schedule for ' + new Date(scheduleAt).toLocaleString());
    scheduledFor = await setSchedule(page, scheduleAt, log);
  } else {
    await ensurePostNow(page);
  }

  onProgress('Verifying post details');
  // Final verification of everything before publishing.
  const desc = normalize(await page.locator('[data-e2e=caption_container] [contenteditable="true"]').first().innerText());
  if (desc !== normalize(`${post.caption} ${hashtags.join(' ')}`)) throw new UiError('Caption changed unexpectedly before posting');
  if (!(await visible(page.getByText(/1 photo uploaded/i)))) throw new UiError('Uploaded photo is no longer attached');
  if (sound && !normalize(await selectedSoundText(page)).includes(normalize(sound.title.split(' - ')[0]))) {
    log.warn('Selected sound disappeared before posting; continuing without claiming a sound.');
    sound = null;
  }

  if (!(await scheduleStillMatches(page, scheduledFor))) throw new UiError('TikTok schedule date/time changed before scheduling');

  await beforePost(sound);
  onProgress(scheduleAt ? 'Scheduling on TikTok' : 'Publishing');
  const res = await clickPostAndConfirm(page, shouldAbort, scheduleAt ? 'Schedule' : 'Post');
  // TikTok's own response right after the click is the confirmation (success message / switch to the Posts page).
  // No Posts-list search: scheduled posts are not listed there before their time anyway.
  const when = scheduledFor ? ` (scheduled on TikTok for ${scheduledFor})` : '';
  if (res.ok) return { published: true, signal: `${res.signal || 'confirmed by TikTok'}${when}`, sound, scheduledFor };
  return {
    published: false,
    failedAfterClick: true,
    message: res.timeout ? `No confirmation from TikTok after clicking ${scheduleAt ? 'Schedule' : 'Post'}` : `TikTok reported: ${res.message}`,
    sound,
    scheduledFor,
  };
}

module.exports = { checkTikTok, publishPhotoPost, rankSounds, collectMusic, tiktokScheduleTime, tzOffsetMinutes, wallClock, MIN_SOUND_USES };
