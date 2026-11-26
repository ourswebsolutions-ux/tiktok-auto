'use strict';
// Automation engine with two independent workers that share the user's Chrome (each in its own tab):
//
//   Image worker:  scheduled -> generating -> ready     (ChatGPT/Gemini: prompt -> image -> caption, saved at once)
//   Upload worker: ready -> uploading -> posting -> tiktok_scheduled | published   (TikTok upload + Post/Schedule)
//
// Image generation never waits for TikTok, and a slow or failing upload never blocks other posts: every post has its
// own retry time (next_try_at). Progress is stored after every step, so a restart continues where it stopped and a
// generated image is never generated again or left behind.

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { ACTIVE_STATUSES } = require('./db');
const { dayKey, planDay, MIN_GAP_MS } = require('./scheduler');
const { ChromeUnavailableError, INSTRUCTIONS } = require('./automation/chrome');
const chatgpt = require('./automation/chatgpt');
const gemini = require('./automation/gemini');
const tiktok = require('./automation/tiktok');
const {
  NeedsHumanError, RateLimitError, AbortedError, UiError, jaccard, sha256, captionKey, detectChallenge, screenshot,
} = require('./automation/util');

// Image + caption generators the user can choose from (same flow, different website).
const AI_PROVIDERS = {
  chatgpt: { name: 'ChatGPT', generatePost: chatgpt.generatePost, check: chatgpt.checkChatGPT },
  gemini: { name: 'Gemini', generatePost: gemini.generatePost, check: gemini.checkGemini },
};

const TICK_MS = 15000;
// Retry timing per post (never blocks other posts): first retry at once, then 15 s, 30 s, max 1 minute, with jitter.
function retryDelayMs(attempt) {
  if (attempt <= 1) return 0;
  const base = Math.min(60000, 15000 * 2 ** (attempt - 2));
  return Math.min(60000, Math.round(base * (0.85 + Math.random() * 0.3)));
}
// TikTok-based mode keeps this many days scheduled ahead (TikTok allows scheduling up to 10 days ahead).
const TIKTOK_DAYS_AHEAD = 10;
const BROWSER_GONE_RE = /Target (page, context or browser )?(has been )?closed|Browser has been closed|browser has disconnected|has been disconnected|Connection closed|WebSocket is not open/i;

const newWorker = (name) => ({ name, busy: false, state: 'idle', text: '', postId: null, attention: null });

class Engine extends EventEmitter {
  constructor({ store, chrome, dirs, log, notify }) {
    super();
    this.store = store;
    this.chrome = chrome;
    this.dirs = dirs;
    this.log = log;
    this.notify = notify || (() => {});
    this.timer = null;
    this.ticking = false;
    this.abortRequested = false;
    this.workers = { gen: newWorker('Image generation'), upload: newWorker('TikTok upload') };
    this.status = { phase: 'stopped', step: '', message: '', instructions: '' };
  }

  get running() { return this.store.getSetting('running', '0') === '1'; }

  get busy() { return this.workers.gen.busy || this.workers.upload.busy; }

  dailyQuantity() { return Number(this.store.getSetting('daily_quantity', '3')) || 0; }

  setStatus(patch) {
    Object.assign(this.status, patch);
    this.emit('change');
  }

  setWorker(key, patch) {
    Object.assign(this.workers[key], patch);
    this.emit('change');
  }

  // ---------- lifecycle ----------
  init() {
    this.store.markOldScheduledMissed(dayKey());
    // Work interrupted by a crash/reboot continues from the last completed step.
    for (const p of this.store.postsWithStatus(['generating'])) {
      this.store.updatePost(p.id, { status: 'scheduled', next_try_at: 0, step: 'Resuming after restart' });
    }
    for (const p of this.store.postsWithStatus(['uploading'])) {
      this.store.updatePost(p.id, { status: 'ready', next_try_at: 0, step: 'Resuming after restart' });
    }
    for (const p of this.store.postsWithStatus(['posting', 'unverified'])) this.recoverPost(p, 'Interrupted while publishing');
    // Posts that already have their image (older versions kept them as "scheduled") are ready for upload.
    for (const p of this.store.postsWithStatus(['scheduled'])) {
      if (p.caption && p.image_path && fs.existsSync(p.image_path)) this.store.updatePost(p.id, { status: 'ready', next_try_at: 0 });
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
      // Fresh start: re-plan today's not-yet-generated slots.
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
    this.setStatus({ phase: conn ? 'running' : 'chrome', step: '' });
    setTimeout(() => this.tick(), 200);
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

  // Which website creates the image and caption: 'chatgpt' (default) or 'gemini'.
  aiProvider() { return this.store.getSetting('ai_provider', 'chatgpt') === 'gemini' ? 'gemini' : 'chatgpt'; }

  ai() { return AI_PROVIDERS[this.aiProvider()]; }

  setAiProvider(p) {
    this.store.setSetting('ai_provider', p === 'gemini' ? 'gemini' : 'chatgpt');
    this.log.info(`Image + caption generator: ${this.ai().name}`);
    this.emit('change');
    if (this.running) setTimeout(() => this.tick(), 200);
  }

  // Sound on each post: 'urdu' = spoken Urdu motivational lines (default), 'music' = mood-matching music.
  soundStyle() { return this.store.getSetting('sound_style', 'urdu') === 'music' ? 'music' : 'urdu'; }

  setSoundStyle(style) {
    this.store.setSetting('sound_style', style === 'music' ? 'music' : 'urdu');
    this.log.info(`Sound: ${this.soundStyle() === 'urdu' ? 'Urdu motivational lines' : 'music'}`);
    this.emit('change');
  }

  // 'software' = the app publishes each post at its calculated time (default).
  // 'tiktok'   = posts are uploaded ahead of time and scheduled with TikTok's own "Schedule" option.
  schedulingMode() { return this.store.getSetting('scheduling_mode', 'software') === 'tiktok' ? 'tiktok' : 'software'; }

  setSchedulingMode(mode) {
    this.store.setSetting('scheduling_mode', mode === 'tiktok' ? 'tiktok' : 'software');
    this.log.info(`Scheduling mode: ${this.schedulingMode() === 'tiktok' ? 'TikTok-based (TikTok schedules the posts)' : 'Software-based'}`);
    this.emit('change');
    if (this.running) setTimeout(() => this.tick(), 200);
  }

  resumeAfterAttention() {
    this.clearAttention();
    this.setStatus({ phase: this.running ? 'running' : 'stopped', message: '' });
    setTimeout(() => this.tick(), 200);
  }

  clearAttention() {
    for (const w of Object.values(this.workers)) {
      if (w.attention && w.attention.page) this.chrome.closePage(w.attention.page);
      w.attention = null;
    }
  }

  // ---------- Chrome ----------
  async ensureChrome() {
    if (this.chrome.isConnected()) return true;
    try {
      await this.chrome.connect();
      if (this.status.phase === 'chrome') this.setStatus({ phase: this.running ? 'running' : 'stopped', message: '', instructions: '' });
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
    for (const [name, fn] of [['ai', this.ai().check], ['tiktok', tiktok.checkTikTok]]) {
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
    const ok = results.ai.ok && results.tiktok.ok;
    if (ok && this.status.phase === 'chrome') this.setStatus({ phase: this.running ? 'running' : 'stopped', message: '', instructions: '' });
    return { ok, mode: this.chrome.info && this.chrome.info.mode, aiName: this.ai().name, ai: results.ai, tiktok: results.tiktok };
  }

  // ---------- schedule ----------
  ensureSchedule() {
    const now = Date.now();
    const today = dayKey();
    this.store.markOldScheduledMissed(today);
    // Software-based: today only. TikTok-based: today + the next days (rolling window), so TikTok always has
    // the coming days scheduled and a new day is added every day - continuously until Stop.
    const days = this.schedulingMode() === 'tiktok' ? TIKTOK_DAYS_AHEAD : 1;
    for (let i = 0; i < days; i++) {
      const date = new Date(now);
      date.setHours(12, 0, 0, 0);
      date.setDate(date.getDate() + i);
      const day = dayKey(date);
      const posts = this.store.postsForDay(day);
      const active = posts.filter((p) => ACTIVE_STATUSES.includes(p.status));
      const plan = planDay({ day, target: this.dailyQuantity(), existingActive: active, totalAttempts: posts.length, now });
      for (const id of plan.remove) this.store.deletePost(id);
      for (const t of plan.add) this.store.createPost(day, t);
      if (plan.add.length || plan.remove.length) {
        this.log.info(`Schedule for ${day}: +${plan.add.length} / -${plan.remove.length} slots (${plan.add.map((t) => new Date(t).toTimeString().slice(0, 5)).join(', ')})`);
        this.emit('change');
      }
    }
  }

  // ---------- main loop: housekeeping, then both workers run independently ----------
  async tick() {
    if (!this.running || this.ticking) return;
    this.ticking = true;
    try {
      this.ensureSchedule();
      const now = Date.now();
      // Older versions' unconfirmed posts: upload again (no confirmation loops).
      for (const p of this.store.postsWithStatus(['unverified'])) this.recoverPost(p, 'Not confirmed by TikTok');
      const oldFailed = this.store.unconfirmedFailedWithContent();
      if (oldFailed) this.recoverPost(oldFailed, 'Earlier post was never confirmed on TikTok');
      // Posts scheduled on TikTok are published by TikTok at their time.
      if (this.store.promoteDueTikTokScheduled(now)) this.emit('change');
      if (!(await this.ensureChrome())) return;
      if (this.status.phase !== 'running' && !this.anyAttention()) this.setStatus({ phase: 'running', step: '' });
    } catch (e) {
      this.log.error(`Tick error: ${e.stack || e.message}`);
    } finally {
      this.ticking = false;
    }
    if (this.running && this.chrome.isConnected()) {
      this.runGenWorker();
      this.runUploadWorker();
    }
  }

  anyAttention() { return Object.values(this.workers).some((w) => w.attention); }

  async attentionResolved(w) {
    const { page, kind } = w.attention;
    if (!page || page.isClosed()) return true;
    if (kind !== 'challenge') return false; // login problems: wait for the user to press Resume
    return !(await detectChallenge(page));
  }

  // Common worker wrapper: one job at a time per worker, then immediately looks for the next one.
  async runWorker(key, pick, job) {
    const w = this.workers[key];
    if (w.busy || !this.running || !this.chrome.isConnected()) return;
    w.busy = true;
    let didWork = false;
    try {
      if (w.attention) {
        if (!(await this.attentionResolved(w))) return;
        this.log.info(`${w.name}: manual intervention resolved, continuing.`);
        if (w.attention.page) await this.chrome.closePage(w.attention.page);
        w.attention = null;
        if (!this.anyAttention()) this.setStatus({ phase: 'running', message: '', step: '' });
      }
      const post = pick();
      if (!post) return;
      didWork = true;
      await job(post);
    } catch (e) {
      this.log.error(`${w.name} error: ${e.stack || e.message}`);
    } finally {
      w.busy = false;
      if (!this.running && !this.busy && this.status.phase === 'stopping') this.setStatus({ phase: 'stopped', step: '' });
      this.emit('change');
      // Continue right away with the next post - no idle time between posts.
      if (didWork && this.running) setTimeout(() => (key === 'gen' ? this.runGenWorker() : this.runUploadWorker()), 500);
    }
  }

  // ---------- image worker ----------
  providerPausedUntil() {
    const until = Number(this.store.getSetting(`${this.aiProvider()}_pause_until`, '0')) || 0;
    return Date.now() < until ? until : 0;
  }

  runGenWorker() {
    return this.runWorker('gen', () => {
      const until = this.providerPausedUntil();
      if (until) {
        this.setWorker('gen', { state: 'paused', postId: null, text: `${this.ai().name} image limit reached - continues automatically at ${new Date(until).toTimeString().slice(0, 5)}` });
        return null;
      }
      const post = this.store.nextToGenerate(Date.now());
      if (!post) {
        const waiting = this.store.countByStatus().scheduled || 0;
        this.setWorker('gen', { state: 'idle', postId: null, text: waiting ? `Retrying shortly (${waiting} waiting for an image)` : 'All planned posts have their image' });
      }
      return post;
    }, (post) => this.generateOne(post));
  }

  postLog(id) {
    return {
      info: (m) => this.log.info(`[post ${id}] ${m}`),
      warn: (m) => this.log.warn(`[post ${id}] ${m}`),
      error: (m) => this.log.error(`[post ${id}] ${m}`),
    };
  }

  async generateOne(post) {
    const id = post.id;
    const log = this.postLog(id);
    const ai = this.ai();
    const step = (s) => { this.store.updatePost(id, { step: s }); this.setWorker('gen', { state: 'working', text: s, postId: id }); log.info(s); };
    this.store.updatePost(id, { status: 'generating', gen_attempts: (post.gen_attempts || 0) + 1, error: null });
    step(`Generating image in ${ai.name}`);
    let page = null;
    let keepPage = false;
    try {
      page = await this.chrome.newPage();
      const p = this.store.getPost(id);
      const prompt = (p.prompt_id && this.store.getPrompt(p.prompt_id)) || this.store.nextPrompt();
      if (!prompt) throw new UiError('No prompts configured');
      this.store.touchPrompt(prompt.id);
      this.store.updatePost(id, { prompt_id: prompt.id, prompt_text: prompt.text, caption: null, image_path: null });
      const recent = this.store.recentContent(40);
      fs.mkdirSync(this.dirs.media, { recursive: true });
      const c = await ai.generatePost(page, {
        userPrompt: prompt.text,
        recent,
        isDuplicate: (x) => this.duplicateReason(x, recent, id),
        isDuplicateImage: (buf) => this.store.imageHashUsed(sha256(buf), id),
        fileBase: path.join(this.dirs.media, `post-${id}-${Date.now()}`),
        log,
        shouldAbort: () => this.abortRequested,
      });
      // Saved immediately: from here on this image is never generated again.
      this.store.updatePost(id, {
        idea: c.idea, title: c.title, caption: c.caption, hashtags: JSON.stringify(c.hashtags), image_prompt: c.prompt_sent,
        music_keywords: JSON.stringify(c.music_keywords), topic_keywords: JSON.stringify(c.topic_keywords), caption_key: captionKey(c.title, c.caption),
        image_path: c.image.file, image_hash: sha256(c.image.buffer),
        status: 'ready', next_try_at: 0, error: null, step: 'Image generated - waiting for upload',
      });
      log.info(`Image generated and saved: ${c.image.file}`);
      setTimeout(() => this.runUploadWorker(), 200);
    } catch (e) {
      keepPage = await this.handleError('gen', id, e, page, log);
    } finally {
      if (page && !keepPage) await this.chrome.closePage(page);
      const w = this.workers.gen;
      this.setWorker('gen', { state: w.attention ? 'attention' : 'idle', text: w.attention ? w.text : '', postId: null });
    }
  }

  // ---------- upload worker ----------
  runUploadWorker() {
    return this.runWorker('upload', () => {
      const now = Date.now();
      const tiktokMode = this.schedulingMode() === 'tiktok';
      const post = this.store.nextToUpload(now, { onlyDue: !tiktokMode });
      if (!post) {
        const next = this.store.nextScheduledPost();
        const ready = this.store.countByStatus().ready || 0;
        let text = 'Waiting for the next generated image';
        if (!tiktokMode && next && next.scheduled_at > now) text = `Next post at ${new Date(next.scheduled_at).toTimeString().slice(0, 5)}`;
        else if (ready) text = `${ready} image(s) ready - next upload shortly`;
        this.setWorker('upload', { state: 'idle', postId: null, text });
        return null;
      }
      if (!tiktokMode) {
        // Software-based: never publish posts back-to-back (e.g. after the computer was asleep).
        const last = this.store.lastPublishActivity();
        if (now - last < MIN_GAP_MS) {
          this.setWorker('upload', { state: 'waiting', postId: null, text: `Keeping a gap between posts - next at ${new Date(last + MIN_GAP_MS).toTimeString().slice(0, 5)}` });
          return null;
        }
      }
      return post;
    }, (post) => this.uploadOne(post));
  }

  async uploadOne(post) {
    const id = post.id;
    const log = this.postLog(id);
    // The image file must exist; if it was deleted, the post goes back to the image worker.
    if (!post.caption || !post.image_path || !fs.existsSync(post.image_path)) {
      this.store.updatePost(id, { status: 'scheduled', caption: null, image_path: null, caption_key: null, image_hash: null, next_try_at: 0, step: 'Image missing - generating again' });
      log.warn('Image file missing - sent back for generation.');
      return;
    }
    // Daily cap guard (never more than the target per day) - the generated image is kept for tomorrow.
    const done = this.store.postsForDay(post.day).filter((x) => ['posting', 'published', 'tiktok_scheduled'].includes(x.status)).length;
    if (done >= this.dailyQuantity()) {
      const tomorrow = (post.slot_at || post.scheduled_at) + 24 * 3600e3;
      this.store.updatePost(id, { day: dayKey(new Date(tomorrow)), slot_at: tomorrow, scheduled_at: tomorrow, step: 'Daily target reached - moved to tomorrow' });
      log.info('Daily target already reached - post (with its image) moved to tomorrow.');
      return;
    }

    const step = (s) => { this.store.updatePost(id, { step: s }); this.setWorker('upload', { state: 'working', text: s, postId: id }); log.info(s); };
    this.store.updatePost(id, { status: 'uploading', attempts: post.attempts + 1, error: null });
    let page = null;
    let keepPage = false;
    try {
      page = await this.chrome.newPage();
      const p = this.store.getPost(id);
      const recentSounds = this.store.recentContent(10).map((r) => r.sound_title).filter(Boolean);
      // TikTok-based: original time if still ahead (TikTok rules: >= 20 min, 5-minute steps), else publish now.
      const slot = p.slot_at || p.scheduled_at;
      const scheduleAt = this.schedulingMode() === 'tiktok' && slot > Date.now() ? tiktok.tiktokScheduleTime(slot) : null;
      if (this.schedulingMode() === 'tiktok' && !scheduleAt) log.info('Original time has passed - publishing now instead of scheduling in the past.');
      const res = await tiktok.publishPhotoPost(page, p, {
        log,
        shouldAbort: () => this.abortRequested,
        recentSounds,
        onProgress: step,
        scheduleAt,
        soundStyle: this.soundStyle(),
        beforePost: async (sound) => {
          // Persisted BEFORE clicking Post/Schedule. The unique index on caption_key throws if this caption was
          // already posted, so a post can never be submitted twice.
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
      } else {
        // TikTok did not confirm (or reported a problem) after the click: upload it again right away.
        log.warn(res.message);
        this.recoverPost(this.store.getPost(id), res.message);
      }
    } catch (e) {
      keepPage = await this.handleError('upload', id, e, page, log);
    } finally {
      // The tab is closed only after the operation has finished or genuinely failed - never during an active upload.
      if (page && !keepPage) await this.chrome.closePage(page);
      const w = this.workers.upload;
      this.setWorker('upload', { state: w.attention ? 'attention' : 'idle', text: w.attention ? w.text : '', postId: null });
    }
  }

  // ---------- errors (per worker; a post's retry never blocks other posts) ----------
  // Returns true when the tab must stay open for the user.
  async handleError(key, id, e, page, log) {
    const post = this.store.getPost(id);
    const now = Date.now();
    const gen = key === 'gen';
    const back = gen ? 'scheduled' : 'ready';
    const attempts = gen ? (post.gen_attempts || 0) : post.attempts;
    const undoAttempt = gen ? { gen_attempts: Math.max(0, attempts - 1) } : { attempts: Math.max(0, attempts - 1) };

    if (!gen && post.status === 'posting') {
      // Something failed while clicking Post/Schedule: upload it again.
      this.recoverPost(post, `Publishing was interrupted (${e.message.split('\n')[0]})`);
      return false;
    }
    if (/UNIQUE constraint failed/i.test(e.message)) {
      this.store.updatePost(id, { status: 'cancelled', error: 'Duplicate caption detected - not published twice' });
      log.warn('Duplicate caption blocked.');
      return false;
    }
    if (e instanceof AbortedError) {
      this.store.updatePost(id, { status: back, ...undoAttempt, next_try_at: 0, step: 'Stopped by user' });
      return false;
    }
    if (e instanceof NeedsHumanError) {
      // Login problems are not retried endlessly: this worker waits for the user (the other worker continues).
      const kind = /not logged in/i.test(e.message) ? 'login' : 'challenge';
      this.store.updatePost(id, { status: back, ...undoAttempt, next_try_at: 0, step: 'Waiting for you in Chrome' });
      const keep = e.page && !e.page.isClosed() ? e.page : page;
      this.workers[key].attention = { message: e.message, kind, page: keep };
      this.setWorker(key, { state: 'attention', text: kind === 'challenge' ? 'Solve the check in Chrome - continues automatically' : 'Log in in Chrome, then press Resume' });
      log.warn(`Needs manual intervention: ${e.message}`);
      if (keep) await keep.bringToFront().catch(() => {});
      this.setStatus({ phase: 'attention', message: e.message });
      this.notify('Action needed in Chrome', e.message);
      return true;
    }
    if (e instanceof ChromeUnavailableError || BROWSER_GONE_RE.test(e.message)) {
      this.store.updatePost(id, { status: back, ...undoAttempt, next_try_at: now + 15000, error: `Chrome connection lost: ${e.message.split('\n')[0]}` });
      log.warn(`Chrome connection lost; will continue when Chrome is available. (${e.message.split('\n')[0]})`);
      this.setStatus({ phase: 'chrome', message: 'Chrome connection lost (closed or crashed). Reopen your Chrome with remote debugging; automation continues automatically.', instructions: INSTRUCTIONS });
      return false;
    }
    const shot = await screenshot(page, this.dirs.screenshots, `post-${id}-error`);
    // Readable error: the step that failed + Playwright's "waiting for ..." target (which element), + screenshot.
    const target = (e.message.match(/waiting for (locator\([^\n]{0,140}|getBy[^\n]{0,140})/) || [])[1];
    const where = post.step ? `${post.step}: ` : '';
    const msg = `${where}${e.message.split('\n')[0]}${target ? ` (waiting for ${target})` : ''}${shot ? ` [screenshot: ${shot}]` : ''}`;
    if (e instanceof RateLimitError) {
      // The AI's image limit applies to every post: the image worker pauses until it resets (uploads continue).
      this.store.setSetting(`${this.aiProvider()}_pause_until`, String(now + e.retryAfterMs));
      this.store.updatePost(id, { status: 'scheduled', ...undoAttempt, next_try_at: now + e.retryAfterMs, error: msg });
      log.warn(`${this.ai().name} limit reached - image generation paused until ${new Date(now + e.retryAfterMs).toTimeString().slice(0, 5)}: ${msg}`);
      this.notify(`${this.ai().name} image limit reached`, `Image generation continues automatically at ${new Date(now + e.retryAfterMs).toTimeString().slice(0, 5)}.`);
      return false;
    }
    // Genuine permanent error: the AI refuses this prompt - retrying the same prompt cannot succeed.
    if (gen && /refused to create the image/i.test(e.message)) {
      this.store.updatePost(id, { status: 'failed', error: msg, step: '' });
      log.error(`FAILED: ${msg}`);
      this.notify('TikTok post failed', msg.slice(0, 180));
      return false;
    }
    // Recoverable: retried on its own timer (at once, then 15 s, 30 s, max 1 min); other posts continue meanwhile.
    const delay = retryDelayMs(attempts);
    this.store.updatePost(id, { status: back, next_try_at: now + delay, error: msg });
    log.warn(`${gen ? 'Image' : 'Upload'} attempt ${attempts} failed, retrying ${delay ? `in ${Math.round(delay / 1000)} s` : 'now'}: ${msg}`);
    return false;
  }

  // A post whose image/caption exist but which is not (confirmed) on TikTok: upload it again with the same content -
  // scheduled for its original time if still ahead, otherwise published immediately.
  recoverPost(post, reason) {
    const slot = post.slot_at || post.scheduled_at;
    const fields = { status: 'ready', next_try_at: 0, verify_checks: 0, error: `${reason} - uploading again`, step: 'Uploading again to TikTok' };
    if (slot <= Date.now()) fields.day = dayKey(); // time passed: it becomes one of today's posts (published now)
    this.store.updatePost(post.id, fields);
    this.log.warn(`[post ${post.id}] ${reason} - uploading it to TikTok again (${slot > Date.now() ? 'scheduled for its original time' : 'published now, its time has passed'}).`);
    this.emit('change');
  }

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

  // ---------- UI state ----------
  snapshot() {
    const today = dayKey();
    const next = this.store.nextScheduledPost();
    const counts = this.store.countByStatus();
    const worker = (w) => ({ state: w.state, text: w.text, postId: w.postId, busy: w.busy, attention: !!w.attention });
    return {
      running: this.running,
      status: { ...this.status, nextPostAt: next ? next.scheduled_at : null, chromeConnected: this.chrome.isConnected() },
      workers: { gen: worker(this.workers.gen), upload: worker(this.workers.upload) },
      queue: { waitingForImage: counts.scheduled || 0, generating: counts.generating || 0, ready: counts.ready || 0, uploading: (counts.uploading || 0) + (counts.posting || 0) },
      dailyQuantity: this.dailyQuantity(),
      schedulingMode: this.schedulingMode(),
      aiProvider: this.aiProvider(),
      soundStyle: this.soundStyle(),
      stats: this.store.stats(today),
      prompts: this.store.listPrompts(),
      history: this.store.history(150).map((h) => ({ ...h, hashtags: h.hashtags ? JSON.parse(h.hashtags) : [] })),
    };
  }
}

module.exports = { Engine, retryDelayMs };
