'use strict';
// SQLite storage for prompts, settings, scheduled/published posts and small caches.
// Uses Node's built-in `node:sqlite` (no native module rebuild needed for Electron).

const SCHEMA = `
CREATE TABLE IF NOT EXISTS prompts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  text TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_used_at INTEGER
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);
CREATE TABLE IF NOT EXISTS posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  day TEXT NOT NULL,
  scheduled_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'scheduled',
  step TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  verify_checks INTEGER NOT NULL DEFAULT 0,
  prompt_id INTEGER,
  prompt_text TEXT,
  idea TEXT,
  image_prompt TEXT,
  caption TEXT,
  hashtags TEXT,
  music_keywords TEXT,
  title TEXT,
  topic_keywords TEXT,
  image_path TEXT,
  image_hash TEXT,
  sound_title TEXT,
  sound_evidence TEXT,
  caption_key TEXT,
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  published_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_posts_day ON posts(day);
CREATE INDEX IF NOT EXISTS idx_posts_status ON posts(status);
-- Hard guarantee against publishing (or scheduling on TikTok) the same caption twice.
DROP INDEX IF EXISTS uniq_posted_caption;
CREATE UNIQUE INDEX IF NOT EXISTS uniq_posted_caption_v2 ON posts(caption_key)
  WHERE status IN ('posting', 'unverified', 'published', 'tiktok_scheduled');
CREATE TABLE IF NOT EXISTS cache (
  key TEXT PRIMARY KEY,
  value TEXT,
  updated_at INTEGER NOT NULL
);
`;

// Statuses
// 'tiktok_scheduled' = uploaded and scheduled with TikTok's own scheduler; published_at holds the TikTok post time.
// Post life cycle: scheduled (slot, no image yet) -> generating -> ready (image + caption saved, waiting for upload)
//   -> uploading -> posting (Post/Schedule clicked) -> tiktok_scheduled | published.
const ACTIVE_STATUSES = ['scheduled', 'generating', 'ready', 'uploading', 'posting', 'unverified', 'published', 'tiktok_scheduled'];
// Pending = still to be uploaded. Posts already scheduled on TikTok are counted separately.
const PENDING_STATUSES = ['scheduled', 'generating', 'ready', 'uploading', 'posting', 'unverified'];
const IN_PROGRESS_STATUSES = ['generating', 'uploading', 'posting'];
const SLOT = 'COALESCE(slot_at, scheduled_at)';

const POST_FIELDS = new Set([
  'day', 'scheduled_at', 'slot_at', 'next_try_at', 'gen_attempts', 'status', 'step', 'attempts', 'verify_checks', 'prompt_id', 'prompt_text', 'idea',
  'image_prompt', 'caption', 'hashtags', 'music_keywords', 'title', 'topic_keywords', 'image_path', 'image_hash',
  'sound_title', 'sound_evidence', 'caption_key', 'error', 'published_at',
]);

function openSqlite(file) {
  let Database;
  try {
    // eslint-disable-next-line global-require
    ({ DatabaseSync: Database } = require('node:sqlite'));
  } catch (e) {
    // eslint-disable-next-line global-require
    Database = require('better-sqlite3');
  }
  return new Database(file);
}

const placeholders = (arr) => arr.map(() => '?').join(',');
const plain = (row) => (row ? { ...row } : null);

class Store {
  constructor(file) {
    this.db = openSqlite(file);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA synchronous = NORMAL;');
    this.db.exec(SCHEMA);
    // Migration: slot_at = the post's intended (calculated) time. scheduled_at is also used as "next attempt" time
    // for retries, so the intended time must be kept separately (TikTok-based scheduling uses it).
    const cols = this.db.prepare('PRAGMA table_info(posts)').all().map((c) => c.name);
    if (!cols.includes('slot_at')) {
      this.db.exec('ALTER TABLE posts ADD COLUMN slot_at INTEGER');
      this.db.exec('UPDATE posts SET slot_at = scheduled_at WHERE slot_at IS NULL');
    }
    // Migration: independent retry bookkeeping for the image worker and the upload worker.
    if (!cols.includes('next_try_at')) this.db.exec('ALTER TABLE posts ADD COLUMN next_try_at INTEGER NOT NULL DEFAULT 0');
    if (!cols.includes('gen_attempts')) this.db.exec('ALTER TABLE posts ADD COLUMN gen_attempts INTEGER NOT NULL DEFAULT 0');
  }

  close() { try { this.db.close(); } catch (_) { /* ignore */ } }

  // ---------- settings ----------
  getSetting(key, fallback = null) {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    return row ? row.value : fallback;
  }

  setSetting(key, value) {
    this.db.prepare('INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, String(value));
  }

  // ---------- cache ----------
  getCache(key, maxAgeMs) {
    const row = this.db.prepare('SELECT value, updated_at FROM cache WHERE key = ?').get(key);
    if (!row || Date.now() - row.updated_at > maxAgeMs) return null;
    try { return JSON.parse(row.value); } catch (_) { return null; }
  }

  setCache(key, value) {
    this.db.prepare('INSERT INTO cache(key, value, updated_at) VALUES(?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at')
      .run(key, JSON.stringify(value), Date.now());
  }

  // ---------- prompts ----------
  listPrompts() {
    return this.db.prepare('SELECT * FROM prompts ORDER BY id ASC').all().map(plain);
  }

  addPrompt(text) {
    const now = Date.now();
    const r = this.db.prepare('INSERT INTO prompts(text, created_at, updated_at) VALUES(?, ?, ?)').run(text, now, now);
    return Number(r.lastInsertRowid);
  }

  updatePrompt(id, text) {
    this.db.prepare('UPDATE prompts SET text = ?, updated_at = ? WHERE id = ?').run(text, Date.now(), id);
  }

  deletePrompt(id) {
    this.db.prepare('DELETE FROM prompts WHERE id = ?').run(id);
  }

  getPrompt(id) {
    return plain(this.db.prepare('SELECT * FROM prompts WHERE id = ?').get(id));
  }

  // Least-recently-used prompt, so multiple prompts rotate fairly.
  nextPrompt() {
    return plain(this.db.prepare(
      'SELECT * FROM prompts ORDER BY (last_used_at IS NOT NULL), last_used_at ASC, id ASC LIMIT 1',
    ).get());
  }

  touchPrompt(id) {
    this.db.prepare('UPDATE prompts SET last_used_at = ? WHERE id = ?').run(Date.now(), id);
  }

  // ---------- posts ----------
  createPost(day, scheduledAt) {
    const now = Date.now();
    const r = this.db.prepare('INSERT INTO posts(day, scheduled_at, slot_at, status, created_at, updated_at) VALUES(?, ?, ?, \'scheduled\', ?, ?)')
      .run(day, scheduledAt, scheduledAt, now, now);
    return Number(r.lastInsertRowid);
  }

  getPost(id) {
    return plain(this.db.prepare('SELECT * FROM posts WHERE id = ?').get(id));
  }

  updatePost(id, fields) {
    const keys = Object.keys(fields).filter((k) => POST_FIELDS.has(k));
    if (!keys.length) return;
    const sql = `UPDATE posts SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`;
    const values = keys.map((k) => (fields[k] === undefined ? null : fields[k]));
    this.db.prepare(sql).run(...values, Date.now(), id);
  }

  deletePost(id) {
    this.db.prepare('DELETE FROM posts WHERE id = ?').run(id);
  }

  postsForDay(day) {
    return this.db.prepare('SELECT * FROM posts WHERE day = ? ORDER BY scheduled_at ASC').all(day).map(plain);
  }

  postsWithStatus(statuses) {
    return this.db.prepare(`SELECT * FROM posts WHERE status IN (${placeholders(statuses)}) ORDER BY scheduled_at ASC`)
      .all(...statuses).map(plain);
  }

  // Image worker: next post that still needs its image + caption (earliest posting time first).
  nextToGenerate(now) {
    return plain(this.db.prepare(
      `SELECT * FROM posts WHERE status = 'scheduled' AND next_try_at <= ? ORDER BY ${SLOT} ASC LIMIT 1`,
    ).get(now));
  }

  // Claims a post for one image worker; false if another tab took it first (central queue, no duplicate jobs).
  claimForGeneration(id) {
    return this.db.prepare('UPDATE posts SET status = \'generating\', updated_at = ? WHERE id = ? AND status = \'scheduled\'').run(Date.now(), id).changes === 1;
  }

  // Upload worker: next post with a ready image whose posting time is <= maxSlot (software-based: now; TikTok-based:
  // inside TikTok's scheduling window). A post waiting for its retry time never blocks the others.
  nextToUpload(now, { maxSlot }) {
    return plain(this.db.prepare(
      `SELECT * FROM posts WHERE status = 'ready' AND next_try_at <= ? AND ${SLOT} <= ? ORDER BY ${SLOT} ASC LIMIT 1`,
    ).get(now, maxSlot));
  }

  // Posts currently waiting on TikTok's scheduler (counts toward TikTok's limit of scheduled posts).
  countFutureTikTokScheduled(now) {
    return Number(this.db.prepare('SELECT COUNT(*) AS c FROM posts WHERE status IN (\'tiktok_scheduled\', \'posting\') AND published_at > ?').get(now).c);
  }

  // Every post that has a generated image (waiting, being uploaded, scheduled or published).
  countImagesGenerated() {
    return Number(this.db.prepare('SELECT COUNT(*) AS c FROM posts WHERE image_hash IS NOT NULL AND status NOT IN (\'cancelled\')').get().c);
  }

  // Last day that has planned posts (continuous generation adds the day after it).
  lastPlannedDay() {
    const row = this.db.prepare('SELECT MAX(day) AS d FROM posts WHERE status NOT IN (\'missed\', \'cancelled\')').get();
    return row && row.d ? row.d : null;
  }

  // Posts scheduled on TikTok whose time has passed are published by TikTok.
  promoteDueTikTokScheduled(now) {
    return this.db.prepare('UPDATE posts SET status = \'published\', updated_at = ? WHERE status = \'tiktok_scheduled\' AND published_at <= ?')
      .run(now, now).changes;
  }

  // Older posts that ended as "could not confirm" but still have their content: candidates for reuse.
  unconfirmedFailedWithContent() {
    return plain(this.db.prepare(
      'SELECT * FROM posts WHERE status = \'failed\' AND caption IS NOT NULL AND image_path IS NOT NULL AND error LIKE \'Could not confirm on TikTok%\' ORDER BY id ASC LIMIT 1',
    ).get());
  }

  // Next post still to be uploaded (for "next post at" in the dashboard).
  nextScheduledPost() {
    const row = plain(this.db.prepare(
      `SELECT *, ${SLOT} AS slot FROM posts WHERE status IN ('scheduled', 'generating', 'ready') ORDER BY ${SLOT} ASC LIMIT 1`,
    ).get());
    if (row) row.scheduled_at = row.slot;
    return row;
  }

  countByStatus() {
    const out = {};
    for (const r of this.db.prepare('SELECT status, COUNT(*) AS c FROM posts GROUP BY status').all()) out[r.status] = Number(r.c);
    return out;
  }

  lastPublishActivity() {
    const row = this.db.prepare(
      'SELECT MAX(COALESCE(published_at, updated_at)) AS t FROM posts WHERE status IN (\'posting\', \'unverified\', \'published\')',
    ).get();
    return row && row.t ? row.t : 0;
  }

  markOldScheduledMissed(today) {
    const now = Date.now();
    // Slots of past days that were never generated are dropped ("missed")...
    this.db.prepare(
      'UPDATE posts SET status = \'missed\', error = \'Computer was off/asleep or automation stopped during this day\', updated_at = ? WHERE day < ? AND status = \'scheduled\' AND (caption IS NULL OR image_path IS NULL)',
    ).run(now, today);
    // ...but a post whose image + caption already exist is never left behind: it becomes one of today's posts.
    this.db.prepare(
      'UPDATE posts SET day = ?, status = \'ready\', updated_at = ? WHERE day < ? AND status IN (\'scheduled\', \'ready\') AND caption IS NOT NULL AND image_path IS NOT NULL',
    ).run(today, now, today);
  }

  history(limit = 200) {
    return this.db.prepare(
      'SELECT id, day, scheduled_at, slot_at, published_at, status, step, title, caption, hashtags, sound_title, sound_evidence, error, attempts, gen_attempts, next_try_at, image_path FROM posts '
      // Published posts and posts already scheduled on TikTok leave the list (they are only counted in the stats).
      + 'WHERE status NOT IN (\'published\', \'tiktok_scheduled\') '
      // Latest activity first; empty future slots (not generated yet) at the end.
      + 'ORDER BY CASE WHEN status = \'scheduled\' AND caption IS NULL THEN 1 ELSE 0 END, updated_at DESC LIMIT ?',
    ).all(limit).map(plain);
  }

  stats(today) {
    const total = this.db.prepare('SELECT COUNT(*) AS c FROM posts WHERE status = \'published\'').get().c;
    const todayCount = this.db.prepare('SELECT COUNT(*) AS c FROM posts WHERE status = \'published\' AND day = ?').get(today).c;
    const pending = this.db.prepare(`SELECT COUNT(*) AS c FROM posts WHERE status IN (${placeholders(PENDING_STATUSES)})`)
      .get(...PENDING_STATUSES).c;
    const onTikTok = this.db.prepare('SELECT COUNT(*) AS c FROM posts WHERE status = \'tiktok_scheduled\'').get().c;
    return { totalPublished: Number(total), todayPublished: Number(todayCount), pending: Number(pending), tiktokScheduled: Number(onTikTok) };
  }

  // Content of recent posts, used to keep ChatGPT from repeating itself.
  recentContent(limit = 40) {
    return this.db.prepare(
      'SELECT id, idea, title, caption, hashtags, image_prompt, image_hash, caption_key, sound_title FROM posts WHERE idea IS NOT NULL AND status NOT IN (\'cancelled\') ORDER BY id DESC LIMIT ?',
    ).all(limit).map(plain);
  }

  captionKeyUsed(key, excludeId) {
    return !!this.db.prepare('SELECT 1 FROM posts WHERE caption_key = ? AND id != ? AND status NOT IN (\'cancelled\') LIMIT 1')
      .get(key, excludeId || 0);
  }

  imageHashUsed(hash, excludeId) {
    return !!this.db.prepare('SELECT 1 FROM posts WHERE image_hash = ? AND id != ? LIMIT 1').get(hash, excludeId || 0);
  }
}

module.exports = { Store, ACTIVE_STATUSES, PENDING_STATUSES, IN_PROGRESS_STATUSES };
