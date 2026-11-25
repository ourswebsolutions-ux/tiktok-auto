'use strict';
// Automation engine: keeps the daily schedule, runs each post through
// ChatGPT (content + image) -> TikTok (upload, sound, caption, publish, confirm), and recovers after restarts.

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { ACTIVE_STATUSES } = require('./db');
const { dayKey, planDay, MIN_GAP_MS } = require('./scheduler');
const { ChromeUnavailableError, INSTRUCTIONS } = require('./automation/chrome');
const chatgpt = require('./automation/chatgpt');
const tiktok = require('./automation/tiktok');
const {
  NeedsHumanError, RateLimitError, AbortedError, UiError, jaccard, sha256, captionKey, detectChallenge, screenshot,
} = require('./automation/util');

const TICK_MS = 15000;
const MAX_ATTEMPTS = 3;
const VERIFY_INTERVAL_MS = 10 * 60 * 1000;
const MAX_VERIFY_CHECKS = 12; // ~2 hours
const TIKTOK_UPLOAD_PAUSE_MS = 60 * 1000; // TikTok-based mode: short pause between uploads
const BROWSER_GONE_RE = /Target (page, context or browser )?(has been )?closed|Browser has been closed|browser has disconnected|has been disconnected|Connection closed|WebSocket is not open/i;

class Engine extends EventEmitter {
  constructor({ store, chrome, dirs, log, notify }) {
    super();
    this.store = store;
    this.chrome = chrome;
    this.dirs = dirs;
    this.log = log;
    this.notify = notify || (() => {});
    this.timer = null;
    this.busy = false;
    this.abortRequested = false;
    this.attention = null; // { message, kind, page }
    this.lastRunEnd = 0;
    this.status = { phase: 'stopped', step: '', message: '', instructions: '', currentPostId: null };
  }

  get running() { return this.store.getSetting('running', '0') === '1'; }

  dailyQuantity() { return Number(this.store.getSetting('daily_quantity', '3')) || 0; }

  setStatus(patch) {
    Object.assign(this.status, patch);
    this.emit('change');
  }

  // ---------- lifecycle ----------
  init() {
    const today = dayKey();
    this.store.markOldScheduledMissed(today);
    const now = Date.now();
    // Work interrupted by a crash/reboot: content steps can safely resume; publishing must be verified first.
    for (const p of this.store.postsWithStatus(['generating', 'uploading'])) {
      this.store.updatePost(p.id, { status: 'scheduled', scheduled_at: now + 60000, step: 'Resuming after restart' });
    }
    for (const p of this.store.postsWithStatus(['posting'])) {
      this.store.updatePost(p.id, { status: 'unverified', scheduled_at: now + 60000, step: 'Interrupted while publishing - checking TikTok before doing anything else' });
    }
    if (this.running) {
      this.log.info('Resuming automation after restart.');
      this.start({ resume: true }).catch((e) => this.log.error(`Resume failed: ${e.message}`));
    }
  }

  async start({ resume = false } = {}) {
    if (!this.store.listPrompts().length) return { ok: false, message: 'Add at least one prompt first.' };
    if (this.dailyQuantity() < 1) return { ok: false, message: 'Set the number of posts per day first.' };
    this.store.setSetting('running', '1');
    this.abortRequested = false;
    if (!resume) {
      // Fresh start: re-plan today's not-yet-started slots.
      for (const p of this.store.postsForDay(dayKey())) {
        if (p.status === 'scheduled' && !p.idea) this.store.deletePost(p.id);
      }
    }
    this.ensureSchedule();
    if (!this.timer) this.timer = setInterval(() => this.tick(), TICK_MS);
    if (!this.chrome.isConnected()) {
      this.setStatus({ phase: 'connecting', step: 'Connecting to your Chrome... if Chrome asks "Allow remote debugging?", click Allow', message: '', instructions: '' });
    }
    const conn = await this.ensureChrome();
    if (!this.running) return { ok: true };
    setTimeout(() => this.tick(), 500);
    this.setStatus({ phase: conn ? 'idle' : 'chrome', step: '' });
    return conn ? { ok: true } : { ok: false, message: this.status.message, instructions: INSTRUCTIONS, started: true };
  }

  stop() {
    this.store.setSetting('running', '0');
    this.abortRequested = true;
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    this.clearAttention();
    this.setStatus({ phase: this.busy ? 'stopping' : 'stopped', step: this.busy ? 'Stopping after the current step...' : '', message: '', instructions: '' });
  }

  setDailyQuantity(n) {
    this.store.setSetting('daily_quantity', String(n));
    if (this.running) this.ensureSchedule();
    this.emit('change');
  }

  // 'software' = the app publishes each post at its calculated time (default).
  // 'tiktok'   = the app uploads posts ahead of time and schedules them with TikTok's own "Schedule" option
  //              for the same calculated times.
  schedulingMode() { return this.store.getSetting('scheduling_mode', 'software') === 'tiktok' ? 'tiktok' : 'software'; }

  setSchedulingMode(mode) {
    this.store.setSetting('scheduling_mode', mode === 'tiktok' ? 'tiktok' : 'software');
    this.log.info(`Scheduling mode: ${this.schedulingMode() === 'tiktok' ? 'TikTok-based (TikTok schedules the posts)' : 'Software-based'}`);
    this.emit('change');
    if (this.running) setTimeout(() => this.tick(), 200);
  }

  resumeAfterAttention() {
    this.clearAttention();
    this.setStatus({ phase: this.running ? 'idle' : 'stopped', message: '' });
    setTimeout(() => this.tick(), 200);
  }

  clearAttention() {
    if (this.attention && this.attention.page) this.chrome.closePage(this.attention.page);
    this.attention = null;
  }

  // ---------- Chrome ----------
  async ensureChrome() {
    if (this.chrome.isConnected()) return true;
    try {
      await this.chrome.connect();
      if (this.status.phase === 'chrome') this.setStatus({ phase: 'idle', message: '', instructions: '' });
      return true;
    } catch (e) {
      this.setStatus({ phase: 'chrome', message: e.message, instructions: INSTRUCTIONS });
      return false;
    }
  }

  async checkChrome() {
    const probe = await this.chrome.probe();
    if (!probe.available) return { ok: false, message: probe.reason, instructions: INSTRUCTIONS };
    try { await this.chrome.connect(); } catch (e) { return { ok: false, message: e.message, instructions: INSTRUCTIONS }; }
    const results = {};
    for (const [name, fn] of [['chatgpt', chatgpt.checkChatGPT], ['tiktok', tiktok.checkTikTok]]) {
      let page;
      try {
        // eslint-disable-next-line no-await-in-loop
        page = await this.chrome.newPage();
        // eslint-disable-next-line no-await-in-loop
        results[name] = await fn(page);
      } catch (e) {
        results[name] = { ok: false, detail: e.message };
      } finally {
        // eslint-disable-next-line no-await-in-loop
        await this.chrome.closePage(page);
      }
    }
    const ok = results.chatgpt.ok && results.tiktok.ok;
    if (ok && this.status.phase === 'chrome') this.setStatus({ phase: this.running ? 'idle' : 'stopped', message: '', instructions: '' });
    return { ok, mode: this.chrome.info && this.chrome.info.mode, chatgpt: results.chatgpt, tiktok: results.tiktok };
  }

  // ---------- schedule ----------
  ensureSchedule() {
    const today = dayKey();
    this.store.markOldScheduledMissed(today);
    const posts = this.store.postsForDay(today);
    const active = posts.filter((p) => ACTIVE_STATUSES.includes(p.status));
    const plan = planDay({ day: today, target: this.dailyQuantity(), existingActive: active, totalAttempts: posts.length, now: Date.now() });
    for (const id of plan.remove) this.store.deletePost(id);
    for (const t of plan.add) this.store.createPost(today, t);
    if (plan.add.length || plan.remove.length) {
      this.log.info(`Schedule for ${today}: +${plan.add.length} / -${plan.remove.length} slots (${plan.add.map((t) => new Date(t).toTimeString().slice(0, 5)).join(', ')})`);
      this.emit('change');
    }
  }

  // ---------- main loop ----------
  async tick() {
    if (!this.running || this.busy) return;
    this.busy = true;
    try {
      this.ensureSchedule();
      if (this.attention) {
        if (!(await this.attentionResolved())) return;
        this.log.info('Manual intervention resolved, continuing.');
        this.clearAttention();
      }
      if (!(await this.ensureChrome())) return;

      const now = Date.now();
      const toVerify = this.store.postsWithStatus(['unverified']).find((p) => p.scheduled_at <= now);
      if (toVerify) { await this.verifyPost(toVerify); return; }

      if (this.store.promoteDueTikTokScheduled(now)) this.emit('change');

      if (this.schedulingMode() === 'tiktok') {
        // TikTok-based: upload the upcoming posts one by one right away; TikTok publishes them at their times.
        const next = this.store.nextTikTokCandidate(now);
        if (!next) {
          const later = this.store.nextScheduledPost();
          this.setStatus({ phase: 'idle', step: '', currentPostId: null, nextPostAt: later ? later.scheduled_at : null });
          return;
        }
        if (now - this.lastRunEnd < TIKTOK_UPLOAD_PAUSE_MS) return; // short pause between uploads
        await this.runPost(next);
        return;
      }

      const due = this.store.nextDuePost(now);
      if (!due) {
        const next = this.store.nextScheduledPost();
        this.setStatus({ phase: 'idle', step: '', currentPostId: null, nextPostAt: next ? next.scheduled_at : null });
        return;
      }
      // Never publish posts back-to-back (e.g. after the computer was asleep).
      const last = this.store.lastPublishActivity();
      if (now - last < MIN_GAP_MS) {
        this.setStatus({ phase: 'idle', step: `Waiting to keep a gap between posts (next at ${new Date(last + MIN_GAP_MS).toTimeString().slice(0, 5)})` });
        return;
      }
      await this.runPost(due);
    } catch (e) {
      this.log.error(`Tick error: ${e.stack || e.message}`);
    } finally {
      this.busy = false;
      if (!this.running && this.status.phase === 'stopping') this.setStatus({ phase: 'stopped', step: '' });
      this.emit('change');
    }
  }

  async attentionResolved() {
    const { page, kind } = this.attention;
    if (!page || page.isClosed()) return true;
    if (kind !== 'challenge') return false; // login problems: wait for the user to press Resume
    return !(await detectChallenge(page));
  }

  shouldAbort() { return this.abortRequested; }

  checkAbort() { if (this.abortRequested) throw new AbortedError(); }

  duplicateReason(c, recent, postId) {
    if (this.store.captionKeyUsed(captionKey(c.title, c.caption), postId)) return 'the caption is identical to an earlier post';
    const tagKey = [...c.hashtags].sort().join(' ');
    for (const r of recent) {
      if (r.id === postId) continue;
      if (r.idea && jaccard(c.idea, r.idea) >= 0.6) return `the idea is too similar to an earlier post ("${r.idea.slice(0, 70)}")`;
      if (r.caption && jaccard(`${c.title} ${c.caption}`, `${r.title || ''} ${r.caption}`) >= 0.55) return 'the caption is too similar to an earlier post';
      if (r.hashtags) {
        try { if ([...JSON.parse(r.hashtags)].sort().join(' ') === tagKey) return 'exactly the same hashtag set was used before'; } catch (_) { /* ignore */ }
      }
    }
    return null;
  }

  async runPost(post) {
    const id = post.id;
    const log = {
      info: (m) => this.log.info(`[post ${id}] ${m}`),
      warn: (m) => this.log.warn(`[post ${id}] ${m}`),
      error: (m) => this.log.error(`[post ${id}] ${m}`),
    };
    const step = (s) => { this.store.updatePost(id, { step: s }); this.setStatus({ phase: 'working', step: s, currentPostId: id }); log.info(s); };
    this.abortRequested = false;
    this.store.updatePost(id, { attempts: post.attempts + 1, status: 'generating', error: null });
    let page = null;
    let keepPage = false;
    try {
      page = await this.chrome.newPage();
      let p = this.store.getPost(id);

      // 1) Image + post details from ChatGPT. Your prompt is sent exactly as written; the caption/hashtags
      //    are then written for the image ChatGPT actually created. Skipped if already done before an interruption.
      if (!p.caption || !p.image_path || !fs.existsSync(p.image_path)) {
        const prompt = (p.prompt_id && this.store.getPrompt(p.prompt_id)) || this.store.nextPrompt();
        if (!prompt) throw new UiError('No prompts configured');
        this.store.touchPrompt(prompt.id);
        this.store.updatePost(id, { prompt_id: prompt.id, prompt_text: prompt.text, caption: null, image_path: null });
        const recent = this.store.recentContent(40);
        step('Creating image in ChatGPT from your prompt');
        fs.mkdirSync(this.dirs.media, { recursive: true });
        const c = await chatgpt.generatePost(page, {
          userPrompt: prompt.text,
          recent,
          isDuplicate: (x) => this.duplicateReason(x, recent, id),
          isDuplicateImage: (buf) => this.store.imageHashUsed(sha256(buf), id),
          fileBase: path.join(this.dirs.media, `post-${id}-${Date.now()}`),
          log,
          shouldAbort: () => this.shouldAbort(),
        });
        this.store.updatePost(id, {
          idea: c.idea, title: c.title, caption: c.caption, hashtags: JSON.stringify(c.hashtags), image_prompt: c.prompt_sent,
          music_keywords: JSON.stringify(c.music_keywords), topic_keywords: JSON.stringify(c.topic_keywords), caption_key: captionKey(c.title, c.caption),
          image_path: c.image.file, image_hash: sha256(c.image.buffer),
        });
        log.info(`Post: ${c.idea}`);
      }
      this.checkAbort();

      // 2) Daily cap guard (never more than the target per day).
      const today = this.store.postsForDay(p.day).filter((x) => ['posting', 'unverified', 'published', 'tiktok_scheduled'].includes(x.status)).length;
      if (today >= this.dailyQuantity()) {
        this.store.updatePost(id, { status: 'cancelled', step: '', error: 'Daily target already reached' });
        return;
      }

      // 3) Publish on TikTok.
      this.store.updatePost(id, { status: 'uploading' });
      p = this.store.getPost(id);
      const recentSounds = this.store.recentContent(10).map((r) => r.sound_title).filter(Boolean);
      // TikTok-based scheduling: same calculated time, adjusted to TikTok's rules (>= 20 min ahead, 5-minute steps).
      const scheduleAt = this.schedulingMode() === 'tiktok' ? tiktok.tiktokScheduleTime(p.scheduled_at) : null;
      const res = await tiktok.publishPhotoPost(page, p, {
        log,
        shouldAbort: () => this.shouldAbort(),
        recentSounds,
        onProgress: step,
        scheduleAt,
        beforePost: async (sound) => {
          // Persist BEFORE clicking Post/Schedule: after a crash we verify instead of re-posting.
          // The unique index on caption_key throws if this caption was already posted.
          this.store.updatePost(id, { status: 'posting', published_at: scheduleAt || Date.now(), sound_title: sound ? sound.title : null, sound_evidence: sound ? sound.evidence : 'No sound added (none relevant with verifiable popularity could be attached)' });
        },
      });
      if (res.published && scheduleAt) {
        this.store.updatePost(id, { status: 'tiktok_scheduled', step: res.signal, error: null });
        log.info(`SCHEDULED ON TIKTOK for ${new Date(scheduleAt).toLocaleString()} (${res.signal})`);
      } else if (res.published) {
        this.store.updatePost(id, { status: 'published', step: res.signal, error: null });
        log.info(`PUBLISHED (${res.signal})`);
        this.notify('Post published on TikTok', p.title || p.caption);
      } else if (res.unverified) {
        this.store.updatePost(id, { status: 'unverified', verify_checks: 0, scheduled_at: Date.now() + VERIFY_INTERVAL_MS, error: res.message, step: 'Waiting to confirm on TikTok' });
        log.warn(res.message);
      } else {
        // TikTok reported a failure after clicking Post. Still verify on the Posts list (a couple of checks)
        // before the slot is released, so a misleading error can never cause a duplicate post.
        this.store.updatePost(id, {
          status: 'unverified', verify_checks: MAX_VERIFY_CHECKS - 2, scheduled_at: Date.now() + 3 * 60 * 1000, error: res.message, step: 'TikTok reported a problem - double-checking',
        });
        log.warn(res.message);
      }
    } catch (e) {
      keepPage = await this.handleError(id, e, page, log);
    } finally {
      if (page && !keepPage) await this.chrome.closePage(page);
      this.lastRunEnd = Date.now();
      this.setStatus({ phase: this.attention ? 'attention' : (this.running ? 'idle' : 'stopped'), step: this.attention ? this.status.step : '', currentPostId: null });
    }
  }

  // Returns true when the tab must stay open for the user.
  async handleError(id, e, page, log) {
    const post = this.store.getPost(id);
    const now = Date.now();
    if (post.status === 'posting') {
      // Something failed after (or while) clicking Post: never retry blindly, verify on TikTok first.
      this.store.updatePost(id, { status: 'unverified', verify_checks: 0, scheduled_at: now + 2 * 60 * 1000, error: `Interrupted while publishing: ${e.message}` });
      log.warn(`Error during publishing (${e.message}); will verify on TikTok before any retry.`);
      return false;
    }
    if (/UNIQUE constraint failed/i.test(e.message)) {
      this.store.updatePost(id, { status: 'cancelled', error: 'Duplicate caption detected - not published twice' });
      log.warn('Duplicate caption blocked.');
      return false;
    }
    if (e instanceof AbortedError) {
      this.store.updatePost(id, { status: 'scheduled', attempts: Math.max(0, post.attempts - 1), step: 'Stopped by user', scheduled_at: now });
      return false;
    }
    if (e instanceof NeedsHumanError) {
      const kind = /not logged in/i.test(e.message) ? 'login' : 'challenge';
      this.store.updatePost(id, { status: 'scheduled', attempts: Math.max(0, post.attempts - 1), scheduled_at: now, step: 'Waiting for you in Chrome' });
      const keep = e.page && !e.page.isClosed() ? e.page : page;
      this.attention = { message: e.message, kind, page: keep };
      log.warn(`Needs manual intervention: ${e.message}`);
      if (keep) await keep.bringToFront().catch(() => {});
      this.setStatus({ phase: 'attention', message: e.message, step: kind === 'challenge' ? 'Solve it in Chrome - automation continues automatically afterwards' : 'Log in, then press Resume' });
      this.notify('Action needed in Chrome', e.message);
      return true;
    }
    if (e instanceof ChromeUnavailableError || BROWSER_GONE_RE.test(e.message)) {
      this.store.updatePost(id, { status: 'scheduled', attempts: Math.max(0, post.attempts - 1), scheduled_at: now + 60000, error: `Chrome connection lost: ${e.message.split('\n')[0]}` });
      log.warn(`Chrome connection lost; will retry when Chrome is available. (${e.message.split('\n')[0]})`);
      this.setStatus({ phase: 'chrome', message: 'Chrome connection lost (closed or crashed). Reopen your Chrome with remote debugging; automation will retry.', instructions: INSTRUCTIONS });
      return false;
    }
    const shot = await screenshot(page, this.dirs.screenshots, `post-${id}-error`);
    const msg = `${e.message.split('\n')[0]}${shot ? ` [screenshot: ${shot}]` : ''}`;
    if (e instanceof RateLimitError) {
      this.store.updatePost(id, { status: 'scheduled', attempts: Math.max(0, post.attempts - 1), scheduled_at: now + e.retryAfterMs, error: msg });
      log.warn(`Rate limited, retrying at ${new Date(now + e.retryAfterMs).toTimeString().slice(0, 5)}: ${msg}`);
      return false;
    }
    if (post.attempts >= MAX_ATTEMPTS) {
      this.store.updatePost(id, { status: 'failed', error: msg, step: '' });
      log.error(`FAILED after ${post.attempts} attempts: ${msg}`);
      this.notify('TikTok post failed', msg.slice(0, 180));
    } else {
      this.store.updatePost(id, { status: 'scheduled', scheduled_at: now + 10 * 60 * 1000 * post.attempts, error: msg });
      log.warn(`Attempt ${post.attempts} failed, will retry: ${msg}`);
    }
    return false;
  }

  async verifyPost(post) {
    const id = post.id;
    this.setStatus({ phase: 'working', step: `Confirming post ${id} on TikTok`, currentPostId: id });
    let page;
    try {
      page = await this.chrome.newPage();
      const listed = await tiktok.findInPostsList(page, { title: post.title, caption: post.caption });
      const scheduledLater = post.published_at && post.published_at > Date.now(); // scheduled on TikTok for later
      if (listed && scheduledLater) {
        this.store.updatePost(id, { status: 'tiktok_scheduled', error: null, step: 'Confirmed in TikTok Posts list (scheduled)' });
        this.log.info(`[post ${id}] Confirmed as scheduled on TikTok.`);
      } else if (listed) {
        this.store.updatePost(id, { status: 'published', published_at: post.published_at || post.updated_at, error: null, step: 'Confirmed in TikTok Posts list' });
        this.log.info(`[post ${id}] Confirmed as published.`);
        this.notify('Post published on TikTok', post.title || post.caption || '');
      } else if (scheduledLater) {
        // TikTok may only list a scheduled post once it is live: keep checking without using up the check limit.
        this.store.updatePost(id, { scheduled_at: Math.max(Date.now() + VERIFY_INTERVAL_MS, post.published_at + 5 * 60 * 1000) });
      } else if (post.verify_checks + 1 >= MAX_VERIFY_CHECKS) {
        this.store.updatePost(id, { status: 'failed', error: 'Could not confirm on TikTok after 2 hours - please check your TikTok profile', step: '' });
      } else {
        this.store.updatePost(id, { verify_checks: post.verify_checks + 1, scheduled_at: Date.now() + VERIFY_INTERVAL_MS });
      }
    } catch (e) {
      if (e instanceof NeedsHumanError) {
        this.attention = { message: e.message, kind: /not logged in/i.test(e.message) ? 'login' : 'challenge', page: e.page || page };
        this.setStatus({ phase: 'attention', message: e.message });
        this.notify('Action needed in Chrome', e.message);
        page = null;
      } else {
        this.log.warn(`[post ${id}] Verification check failed: ${e.message.split('\n')[0]}`);
        this.store.updatePost(id, { verify_checks: post.verify_checks + 1, scheduled_at: Date.now() + VERIFY_INTERVAL_MS });
      }
    } finally {
      if (page) await this.chrome.closePage(page);
      this.setStatus({ phase: this.attention ? 'attention' : 'idle', currentPostId: null, step: this.attention ? this.status.step : '' });
    }
  }

  // ---------- UI state ----------
  snapshot() {
    const today = dayKey();
    const next = this.store.nextScheduledPost();
    return {
      running: this.running,
      status: { ...this.status, nextPostAt: next ? next.scheduled_at : null, chromeConnected: this.chrome.isConnected() },
      dailyQuantity: this.dailyQuantity(),
      schedulingMode: this.schedulingMode(),
      stats: this.store.stats(today),
      prompts: this.store.listPrompts(),
      history: this.store.history(150).map((h) => ({ ...h, hashtags: h.hashtags ? JSON.parse(h.hashtags) : [] })),
    };
  }
}

module.exports = { Engine };
