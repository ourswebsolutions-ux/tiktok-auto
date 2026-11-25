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
-- Hard guarantee against publishing the same caption twice.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_posted_caption ON posts(caption_key)
  WHERE status IN ('posting', 'unverified', 'published');
CREATE TABLE IF NOT EXISTS cache (
  key TEXT PRIMARY KEY,
  value TEXT,
  updated_at INTEGER NOT NULL
);
`;

// Statuses
const ACTIVE_STATUSES = ['scheduled', 'generating', 'uploading', 'posting', 'unverified', 'published'];
const PENDING_STATUSES = ['scheduled', 'generating', 'uploading', 'posting', 'unverified'];
const IN_PROGRESS_STATUSES = ['generating', 'uploading', 'posting'];

const POST_FIELDS = new Set([
  'day', 'scheduled_at', 'status', 'step', 'attempts', 'verify_checks', 'prompt_id', 'prompt_text', 'idea',
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
    const r = this.db.prepare('INSERT INTO posts(day, scheduled_at, status, created_at, updated_at) VALUES(?, ?, \'scheduled\', ?, ?)')
      .run(day, scheduledAt, now, now);
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

  nextDuePost(now) {
    return plain(this.db.prepare(
      'SELECT * FROM posts WHERE status = \'scheduled\' AND scheduled_at <= ? ORDER BY scheduled_at ASC LIMIT 1',
    ).get(now));
  }

  nextScheduledPost() {
    return plain(this.db.prepare(
      'SELECT * FROM posts WHERE status = \'scheduled\' ORDER BY scheduled_at ASC LIMIT 1',
    ).get());
  }

  lastPublishActivity() {
    const row = this.db.prepare(
      'SELECT MAX(COALESCE(published_at, updated_at)) AS t FROM posts WHERE status IN (\'posting\', \'unverified\', \'published\')',
    ).get();
    return row && row.t ? row.t : 0;
  }

  markOldScheduledMissed(today) {
    this.db.prepare(
      'UPDATE posts SET status = \'missed\', error = \'Computer was off/asleep or automation stopped during this day\', updated_at = ? WHERE day < ? AND status = \'scheduled\'',
    ).run(Date.now(), today);
  }

  history(limit = 200) {
    return this.db.prepare(
      'SELECT id, day, scheduled_at, published_at, status, step, title, caption, hashtags, sound_title, sound_evidence, error, attempts, image_path FROM posts '
      + 'ORDER BY COALESCE(published_at, scheduled_at) DESC LIMIT ?',
    ).all(limit).map(plain);
  }

  stats(today) {
    const total = this.db.prepare('SELECT COUNT(*) AS c FROM posts WHERE status = \'published\'').get().c;
    const todayCount = this.db.prepare('SELECT COUNT(*) AS c FROM posts WHERE status = \'published\' AND day = ?').get(today).c;
    const pending = this.db.prepare(`SELECT COUNT(*) AS c FROM posts WHERE status IN (${placeholders(PENDING_STATUSES)})`)
      .get(...PENDING_STATUSES).c;
    return { totalPublished: Number(total), todayPublished: Number(todayCount), pending: Number(pending) };
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
