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

test('engine init: interrupted publishing is verified, never re-posted; old slots marked missed', () => {
  const { Engine } = require('../src/main/engine');
  const store = new Store(tmpDb());
  const yesterday = dayKey(new Date(Date.now() - 86400e3));
  const old = store.createPost(yesterday, Date.now() - 86400e3);
  const gen = store.createPost(dayKey(), Date.now() - 1000);
  const posting = store.createPost(dayKey(), Date.now() - 1000);
  store.updatePost(gen, { status: 'generating' });
  store.updatePost(posting, { status: 'posting', caption_key: 'k1' });
  const log = { info() {}, warn() {}, error() {} };
  const engine = new Engine({ store, chrome: { isConnected: () => false }, dirs: {}, log });
  engine.init();
  assert.strictEqual(store.getPost(old).status, 'missed');
  assert.strictEqual(store.getPost(gen).status, 'scheduled');
  assert.strictEqual(store.getPost(posting).status, 'unverified');
  store.close();
});

test('similarity helper', () => {
  assert.ok(jaccard('morning coffee routine for creators', 'morning coffee routine for busy creators') > 0.6);
  assert.ok(jaccard('ocean waves at night', 'city skyline at noon') < 0.2);
});

test('TikTok-based scheduling: upload order, retry delay respected, promotion to published', () => {
  const store = new Store(tmpDb());
  const day = dayKey();
  const now = Date.now();
  const later = store.createPost(day, now + 5 * 3600e3);
  const sooner = store.createPost(day, now + 2 * 3600e3);
  const retrying = store.createPost(day, now + 30 * 60e3);
  store.updatePost(retrying, { attempts: 1, error: 'temporary failure' });
  assert.strictEqual(store.nextTikTokCandidate(now).id, sooner, 'upcoming posts are uploaded ahead of time, earliest first');
  store.updatePost(sooner, { status: 'tiktok_scheduled', published_at: now + 2 * 3600e3, caption_key: 'a' });
  assert.strictEqual(store.nextTikTokCandidate(now).id, later, 'a post waiting for its retry time is skipped');
  assert.strictEqual(store.stats(day).pending, 3);
  assert.strictEqual(store.promoteDueTikTokScheduled(now + 3 * 3600e3), 1);
  assert.strictEqual(store.getPost(sooner).status, 'published');
  store.updatePost(later, { caption_key: 'a' });
  assert.throws(() => store.updatePost(later, { status: 'tiktok_scheduled' }), /UNIQUE/, 'same caption cannot be scheduled twice');
  store.close();
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

test('ChatGPT Free image limit: reset time parsed, all image creation paused, generated posts continue', () => {
  const { limitResetDelay } = require('../src/main/automation/chatgpt');
  const { Engine } = require('../src/main/engine');
  const now = new Date(2026, 10, 26, 14, 10).getTime();
  const msg = 'There’s not enough usage available on your plan to create images right now, but more will be available after 5:59 PM.';
  assert.strictEqual(new Date(now + limitResetDelay(msg, now)).getHours(), 18);
  const store = new Store(tmpDb());
  const engine = new Engine({ store, chrome: { isConnected: () => false }, dirs: {}, log: { info() {}, warn() {}, error() {} } });
  store.setSetting('chatgpt_pause_until', String(Date.now() + 3600e3));
  assert.ok(engine.chatgptPaused({ caption: null, image_path: null }) > Date.now(), 'post needing an image waits');
  assert.strictEqual(engine.chatgptPaused({ caption: 'x', image_path: __filename }), 0, 'already generated post continues');
  store.setSetting('chatgpt_pause_until', String(Date.now() - 1000));
  assert.strictEqual(engine.chatgptPaused({ caption: null, image_path: null }), 0, 'pause ends by itself');
  store.close();
});
