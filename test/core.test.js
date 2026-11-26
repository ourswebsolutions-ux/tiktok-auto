'use strict';
const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { planTimes, planDay, atLocal, dayKey, MIN_GAP_MS } = require('../src/main/scheduler');
const { Store } = require('../src/main/db');
const { extractJson, normalizeContent, imageType } = require('../src/main/automation/chatgpt');
const { rankSounds, collectMusic } = require('../src/main/automation/tiktok');
const { captionKey, jaccard } = require('../src/main/automation/util');

const tmpDb = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tap-')), 'test.db');

test('planTimes spreads posts with minimum gaps inside the window', () => {
  const from = atLocal('2026-11-25', 0); const to = atLocal('2026-11-25', 24 * 60 - 5);
  for (const n of [1, 3, 5, 10, 20]) {
    const t = planTimes(n, from, to);
    assert.strictEqual(t.length, n);
    t.forEach((x, i) => { assert.ok(x >= from && x <= to); if (i) assert.ok(x - t[i - 1] >= MIN_GAP_MS); });
  }
});

test('planDay: full day, late start, reduce quantity, replacement cap', () => {
  const day = '2026-11-25';
  const midnight = atLocal(day, 0);
  const a = planDay({ day, target: 6, existingActive: [], totalAttempts: 0, now: midnight });
  assert.strictEqual(a.add.length, 6);
  assert.ok(Math.min(...a.add) < atLocal(day, 4 * 60), 'first post in the night hours: whole 24h are used');
  assert.ok(Math.max(...a.add) > atLocal(day, 20 * 60), 'last post late in the evening');
  const gaps = a.add.slice(1).map((t, i) => t - a.add[i]);
  assert.ok(Math.min(...gaps) >= 2 * 3600e3, 'roughly every 4 hours for 6 posts');

  const late = atLocal(day, 22 * 60 + 30); // 22:30: remaining posts squeezed into the remaining time
  const b = planDay({ day, target: 4, existingActive: [], totalAttempts: 0, now: late });
  assert.ok(b.add.length >= 2 && b.add.length <= 3);
  assert.ok(Math.max(...b.add) <= atLocal(day, 23 * 60 + 55));
  const morning = atLocal(day, 7 * 60);

  const existing = [1, 2, 3, 4, 5].map((i) => ({ id: i, status: 'scheduled', scheduled_at: morning + i * 3600e3 }));
  const c = planDay({ day, target: 3, existingActive: existing, totalAttempts: 5, now: morning });
  assert.deepStrictEqual(c.remove.sort(), [4, 5]);

  const d = planDay({ day, target: 3, existingActive: [], totalAttempts: 9, now: morning });
  assert.strictEqual(d.add.length, 0, 'no endless replacement of failed posts');
});

test('ChatGPT JSON extraction and normalisation', () => {
  const reply = 'json\nCopy code\n{"idea":"Sunrise over a misty lake","title":"Start fresh #new","caption":"Every sunrise is a new chance ☀️ #sunrise","hashtags":["sunrise","#Motivation","#fyp","#fyp"],"music_keywords":["calm piano","uplifting"],"topic_keywords":["sunrise"]}';
  const c = normalizeContent(extractJson(reply));
  assert.strictEqual(c.title, 'Start fresh');
  assert.strictEqual(c.caption, 'Every sunrise is a new chance ☀️');
  assert.deepStrictEqual(c.hashtags, ['#sunrise', '#motivation', '#fyp']);
  assert.throws(() => normalizeContent(extractJson('{"idea":"x"}')));
  assert.strictEqual(imageType(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0, 0])), 'png');
});

test('sound ranking: relevant + verified popularity only, no repeats', () => {
  const m = new Map();
  collectMusic({ data: [
    { music_info: { id_str: '1', title: 'Calm Piano Morning', author: 'A', user_count: 500000 } },
    { music_info: { id_str: '2', title: 'Unknown Track', author: 'B', user_count: 50 } },
    { music_info: { id_str: '3', title: 'Piano Dreams', author: 'C', user_count: 2000000 } },
  ] }, 'search:calm piano', m);
  collectMusic({ music_list: [{ id_str: '4', title: 'Party Hit', author: 'D', user_count: 9000000 }] }, 'recommended-for-this-photo', m);
  const ranked = rankSounds(m, { keywords: ['calm piano'], topicKeywords: ['sunrise'], recentSounds: ['Piano Dreams - C'] });
  const ids = ranked.map((r) => r.id);
  assert.ok(!ids.includes('2'), 'unverifiable popularity excluded');
  assert.ok(!ids.includes('3'), 'recently used sound excluded');
  assert.strictEqual(ids[0], '1', 'relevant search match ranks first');
});

test('store: duplicate caption cannot be posted twice; stats; recovery-friendly', () => {
  const store = new Store(tmpDb());
  const day = dayKey();
  store.addPrompt('test prompt');
  const a = store.createPost(day, Date.now());
  const b = store.createPost(day, Date.now());
  const key = captionKey('Title', 'Same caption');
  store.updatePost(a, { caption_key: key, status: 'posting' });
  store.updatePost(a, { status: 'published', published_at: Date.now() });
  store.updatePost(b, { caption_key: key });
  assert.throws(() => store.updatePost(b, { status: 'posting' }), /UNIQUE/);
  assert.ok(store.captionKeyUsed(key, b));
  const s = store.stats(day);
  assert.strictEqual(s.totalPublished, 1);
  assert.strictEqual(s.todayPublished, 1);
  assert.strictEqual(s.pending, 1);
  assert.strictEqual(store.nextPrompt().text, 'test prompt');
  store.close();
});

test('similarity helper', () => {
  assert.ok(jaccard('morning coffee routine for creators', 'morning coffee routine for busy creators') > 0.6);
  assert.ok(jaccard('ocean waves at night', 'city skyline at noon') < 0.2);
});

test('TikTok schedule time: 5-minute steps and at least 20 minutes ahead', () => {
  const { tiktokScheduleTime } = require('../src/main/automation/tiktok');
  const now = new Date(2026, 10, 26, 10, 0).getTime();
  assert.strictEqual(new Date(tiktokScheduleTime(new Date(2026, 10, 26, 15, 7).getTime(), now)).getMinutes(), 10);
  assert.strictEqual(tiktokScheduleTime(now + 60e3, now), now + 20 * 60e3);
});

test('TikTok-based mode keeps 10 days scheduled ahead; software mode only today', () => {
  const { Engine } = require('../src/main/engine');
  const store = new Store(tmpDb());
  store.setSetting('daily_quantity', '12');
  const log = { info() {}, warn() {}, error() {} };
  const engine = new Engine({ store, chrome: { isConnected: () => false }, dirs: {}, log });
  store.setSetting('scheduling_mode', 'software');
  engine.ensureSchedule();
  const daysSoftware = new Set(store.postsWithStatus(['scheduled']).map((p) => p.day));
  assert.strictEqual(daysSoftware.size <= 1, true);
  store.setSetting('scheduling_mode', 'tiktok');
  engine.ensureSchedule();
  const posts = store.postsWithStatus(['scheduled']);
  const perDay = {};
  posts.forEach((p) => { perDay[p.day] = (perDay[p.day] || 0) + 1; });
  const days = Object.keys(perDay).sort();
  assert.ok(days.length >= 9 && days.length <= 10, 'rolling window of 10 days');
  days.slice(1).forEach((d) => assert.strictEqual(perDay[d], 12, 'future days get the full daily quantity'));
  engine.ensureSchedule();
  assert.strictEqual(store.postsWithStatus(['scheduled']).length, posts.length, 'no duplicates when planned again');
  store.close();
});

test('TikTok schedule timezone is read from TikTok and the time converted into it', () => {
  const { tzOffsetMinutes, wallClock } = require('../src/main/automation/tiktok');
  assert.strictEqual(tzOffsetMinutes('(GMT+5) Local Time'), 300);
  assert.strictEqual(tzOffsetMinutes('(GMT-3:30) St Johns'), -210);
  assert.strictEqual(tzOffsetMinutes('(GMT) London'), 0);
  assert.strictEqual(tzOffsetMinutes(''), null);
  const instant = Date.UTC(2026, 10, 25, 23, 45); // 04:45 in GMT+5
  const pk = wallClock(instant, 300);
  assert.deepStrictEqual([pk.d, pk.h, pk.mi], [26, 4, 45]);
  const cn = wallClock(instant, 480); // the same instant on a GMT+8 TikTok clock
  assert.deepStrictEqual([cn.d, cn.h, cn.mi], [26, 7, 45]);
});

test('published and TikTok-scheduled posts leave the list and are only counted in the stats', () => {
  const store = new Store(tmpDb());
  const day = dayKey();
  const a = store.createPost(day, Date.now());
  const b = store.createPost(day, Date.now() + 3600e3);
  const c = store.createPost(day, Date.now() + 7200e3);
  store.updatePost(a, { status: 'published', published_at: Date.now(), caption: 'x' });
  store.updatePost(c, { status: 'tiktok_scheduled', published_at: Date.now() + 7200e3, caption: 'y' });
  assert.deepStrictEqual(store.history().map((h) => h.id), [b]);
  assert.strictEqual(store.stats(day).tiktokScheduled, 1);
  assert.strictEqual(store.stats(day).pending, 1, 'pending = still to be uploaded');
  assert.strictEqual(store.stats(day).totalPublished, 1);
  assert.strictEqual(store.stats(day).todayPublished, 1);
  store.close();
});

// ---------- two independent workers (image generation / TikTok upload) ----------
const quietLog = { info() {}, warn() {}, error() {} };
const makeEngine = (store) => {
  const { Engine } = require('../src/main/engine');
  return new Engine({ store, chrome: { isConnected: () => false, closePage: async () => {} }, dirs: { screenshots: os.tmpdir(), media: os.tmpdir() }, log: quietLog });
};

test('init: every post continues from its last completed step', () => {
  const store = new Store(tmpDb());
  const now = Date.now();
  const yesterday = dayKey(new Date(now - 86400e3));
  const oldEmpty = store.createPost(yesterday, now - 86400e3);
  const gen = store.createPost(dayKey(), now + 3600e3);
  const up = store.createPost(dayKey(), now + 3600e3);
  const posting = store.createPost(dayKey(), now + 7200e3);
  const legacy = store.createPost(dayKey(), now + 9000e3);
  store.updatePost(gen, { status: 'generating' });
  store.updatePost(up, { status: 'uploading', caption: 'a', image_path: __filename });
  store.updatePost(posting, { status: 'posting', caption: 'b', image_path: __filename, caption_key: 'k1' });
  store.updatePost(legacy, { caption: 'c', image_path: __filename });
  makeEngine(store).init();
  assert.strictEqual(store.getPost(oldEmpty).status, 'missed');
  assert.strictEqual(store.getPost(gen).status, 'scheduled', 'generation restarts');
  assert.strictEqual(store.getPost(up).status, 'ready', 'image kept, upload restarts');
  assert.strictEqual(store.getPost(posting).status, 'ready', 'interrupted publishing is uploaded again');
  assert.strictEqual(store.getPost(legacy).status, 'ready', 'an existing image is never generated again');
  store.close();
});

test('workers have independent queues; a retrying post never blocks the others', () => {
  const store = new Store(tmpDb());
  const now = Date.now();
  const day = dayKey();
  const a = store.createPost(day, now + 3600e3);
  const b = store.createPost(day, now + 7200e3);
  const c = store.createPost(day, now + 9000e3);
  store.updatePost(a, { status: 'ready', caption: 'a', image_path: __filename, next_try_at: now + 60000, error: 'upload failed' });
  store.updatePost(b, { status: 'ready', caption: 'b', image_path: __filename });
  assert.strictEqual(store.nextToGenerate(now).id, c, 'image worker only takes posts without an image');
  assert.strictEqual(store.nextToUpload(now, { onlyDue: false }).id, b, 'post a is waiting for its retry time - post b goes ahead');
  assert.strictEqual(store.nextToUpload(now + 61000, { onlyDue: false }).id, a, 'post a is retried after its delay (earliest time first)');
  assert.strictEqual(store.nextToUpload(now, { onlyDue: true }), null, 'software mode: not before the posting time');
  assert.strictEqual(store.getPost(a).slot_at, now + 3600e3, 'retries never change the posting time');
  store.close();
});

test('upload failures retry on their own timer (image kept); generation limits never stop uploads', async () => {
  const { UiError, RateLimitError } = require('../src/main/automation/util');
  const store = new Store(tmpDb());
  const engine = makeEngine(store);
  const id = store.createPost(dayKey(), Date.now() + 3600e3);
  store.updatePost(id, { status: 'uploading', attempts: 1, caption: 'c', image_path: __filename });
  await engine.handleError('upload', id, new UiError('Uploading image to TikTok: connection stalled'), null, quietLog);
  let p = store.getPost(id);
  assert.strictEqual(p.status, 'ready');
  assert.strictEqual(p.image_path, __filename, 'generated image is kept, only the upload is repeated');
  assert.ok(p.next_try_at - Date.now() < 2000, 'first retry immediately');
  store.updatePost(id, { status: 'uploading', attempts: 6 });
  await engine.handleError('upload', id, new UiError('stalled'), null, quietLog);
  p = store.getPost(id);
  assert.ok(p.next_try_at - Date.now() <= 61000, 'never waits more than about 1 minute');

  const g = store.createPost(dayKey(), Date.now() + 7200e3);
  store.updatePost(g, { status: 'generating', gen_attempts: 1 });
  await engine.handleError('gen', g, new RateLimitError('ChatGPT image/usage limit reached', 3600e3), null, quietLog);
  assert.strictEqual(store.getPost(g).status, 'scheduled');
  assert.ok(engine.providerPausedUntil() > Date.now(), 'image generation pauses for the limit');
  assert.strictEqual(store.nextToUpload(Date.now() + 61000, { onlyDue: false }).id, id, 'uploads continue during the image limit');

  const r = store.createPost(dayKey(), Date.now() + 9000e3);
  store.updatePost(r, { status: 'generating', gen_attempts: 1 });
  await engine.handleError('gen', r, new UiError('ChatGPT refused to create the image: policy'), null, quietLog);
  assert.strictEqual(store.getPost(r).status, 'failed', 'a refused prompt is a genuine permanent error');
  store.close();
});

test('recovery: not confirmed -> uploaded again (original time if ahead, otherwise published now)', () => {
  const store = new Store(tmpDb());
  const engine = makeEngine(store);
  const now = Date.now();
  const future = store.createPost(dayKey(), now + 3 * 3600e3);
  store.updatePost(future, { status: 'posting', caption: 'c1', image_path: __filename });
  engine.recoverPost(store.getPost(future), 'Not confirmed by TikTok');
  assert.strictEqual(store.getPost(future).status, 'ready');
  assert.strictEqual(store.getPost(future).slot_at, now + 3 * 3600e3);
  const yesterday = dayKey(new Date(now - 86400e3));
  const past = store.createPost(yesterday, now - 86400e3);
  store.updatePost(past, { status: 'failed', caption: 'c2', image_path: __filename, error: 'Could not confirm on TikTok after 2 hours' });
  engine.recoverPost(store.getPost(past), 'Earlier post was never confirmed on TikTok');
  assert.strictEqual(store.getPost(past).day, dayKey());
  store.close();
});

test('retry timing: immediately, then 15 s, 30 s, never more than 1 minute', () => {
  const { retryDelayMs } = require('../src/main/engine');
  assert.strictEqual(retryDelayMs(1), 0);
  assert.ok(retryDelayMs(2) >= 12000 && retryDelayMs(2) <= 18000);
  assert.ok(retryDelayMs(3) >= 25000 && retryDelayMs(3) <= 35000);
  for (let n = 4; n < 20; n++) assert.ok(retryDelayMs(n) <= 60000);
});

test('slow internet: pages open despite network errors; uploads wait while active and fail only when stalled', async () => {
  const { gotoSafe, waitActive } = require('../src/main/automation/util');
  let calls = 0;
  const realSetTimeout = global.setTimeout;
  global.setTimeout = (fn) => realSetTimeout(fn, 0); // skip waits in the test
  try {
    await gotoSafe({ goto: async () => { calls++; if (calls < 3) throw new Error('page.goto: net::ERR_CONNECTION_RESET'); } }, 'https://x');
  } finally { global.setTimeout = realSetTimeout; }
  assert.strictEqual(calls, 3, 'opened on the third try');

  const fakePage = {
    isClosed: () => false,
    evaluate: async () => null,
    title: async () => '',
    url: () => 'https://www.tiktok.com/tiktokstudio/upload',
    locator: () => ({ first: () => ({ isVisible: async () => false }) }),
  };
  // Active upload (a request in flight) for ~2.5 s with a 1 s idle timeout: must NOT fail, finishes when done.
  const busy = { inflight: 1, idleFor() { return this.inflight ? 0 : 5000; }, touch() {} };
  let done = false;
  realSetTimeout(() => { done = true; }, 2500);
  await waitActive(fakePage, busy, () => done, { idleTimeout: 1000, label: 'Uploading image to TikTok' });
  assert.ok(done, 'kept waiting while the upload was active');
  // Nothing moving at all: reported as stalled.
  const stalled = { idleFor: () => 5000, touch() {} };
  await assert.rejects(waitActive(fakePage, stalled, () => false, { idleTimeout: 1000, label: 'Uploading image to TikTok' }), /no upload activity/);
});


test('image generation and TikTok upload run at the same time (one never waits for the other)', async () => {
  const { Engine } = require('../src/main/engine');
  const store = new Store(tmpDb());
  store.addPrompt('p');
  store.setSetting('daily_quantity', '3');
  store.setSetting('running', '1');
  const engine = new Engine({ store, chrome: { isConnected: () => true, closePage: async () => {} }, dirs: {}, log: quietLog });
  const now = Date.now();
  store.createPost(dayKey(), now + 3600e3); // needs an image
  const ready = store.createPost(dayKey(), now + 7200e3);
  store.updatePost(ready, { status: 'ready', caption: 'c', image_path: __filename });
  store.setSetting('scheduling_mode', 'tiktok');
  let overlap = false;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  engine.generateOne = async () => { await wait(300); };
  engine.uploadOne = async () => { overlap = overlap || engine.workers.gen.busy; await wait(300); };
  const g = engine.runGenWorker();
  const u = engine.runUploadWorker();
  await Promise.all([g, u]);
  store.setSetting('running', '0'); // stop follow-up runs
  assert.ok(overlap, 'upload ran while the image worker was busy');
  await wait(600);
  store.close();
});
