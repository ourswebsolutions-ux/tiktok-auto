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

  const d = planDay({ day, target: 3, existingActive: [], totalAttempts: 6, now: morning });
  assert.strictEqual(d.add.length, 0, 'no endless replacement of failed posts');
});

test('ChatGPT JSON extraction and normalisation', () => {
  const reply = 'json\nCopy code\n{"idea":"Sunrise over a misty lake","title":"Start fresh #new","caption":"Every sunrise is a new chance ☀️ #sunrise","hashtags":["sunrise","#Motivation","#fyp","#fyp"],"image_prompt":"A misty lake at sunrise, golden light, vertical composition, cinematic","music_keywords":["calm piano","uplifting"],"topic_keywords":["sunrise"]}';
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
