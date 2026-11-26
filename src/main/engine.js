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
// Continuous generation plans new days ahead of time - at most this far (safety cap for disk space).
const MAX_QUEUE_DAYS = 365;
const BROWSER_GONE_RE = /Target (page, context or browser )?(has been )?closed|Browser has been closed|browser has disconnected|has been disconnected|Connection closed|WebSocket is not open/i;

// Worker = one job at a time. Image workers ("gen-0" ... "gen-9") each own one ChatGPT/Gemini tab that stays open and
// is reused (new chat per post, retries in the same tab); the upload worker uses its own TikTok tab per job.
const newWorker = (name) => ({ name, busy: false, state: 'idle', text: '', postId: null, attention: null, page: null, cooldownUntil: 0, retired: false });
const MIN_TABS = 2;
const MAX_TABS = 10;

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
    this.abort = { gen: false, upload: false };
    this.workers = { upload: newWorker('TikTok upload') };
    this.syncGenWorkers();
    this.status = { phase: 'stopped', step: '', message: '', instructions: '' };
  }

  // Two independent switches: "Generate images" and "Auto upload to TikTok". Automation runs while either is on.
  genEnabled() { return this.store.getSetting('gen_enabled', this.store.getSetting('running', '0')) === '1'; }

  uploadEnabled() { return this.store.getSetting('upload_enabled', this.store.getSetting('running', '0')) === '1'; }

  get running() { return this.genEnabled() || this.uploadEnabled(); }

  workerEnabled(key) {
    if (key === 'upload') return this.uploadEnabled();
    return this.genEnabled() && !!this.workers[key] && !this.workers[key].retired;
  }

  // ---------- image generation mode: one tab, or several tabs in parallel ----------
  genMode() { return this.store.getSetting('gen_mode', 'single') === 'multi' ? 'multi' : 'single'; }

  genTabs() { return Math.max(MIN_TABS, Math.min(MAX_TABS, Number(this.store.getSetting('gen_tabs', '5')) || 5)); }

  genCount() { return this.genMode() === 'multi' ? this.genTabs() : 1; }

  genKeys() { return Object.keys(this.workers).filter((k) => k.startsWith('gen-') && !this.workers[k].retired); }

  // Creates/retires image workers to match the selected mode. A retired worker finishes its current post first.
  syncGenWorkers() {
    const n = this.genCount();
    for (let i = 0; i < n; i++) {
      const k = `gen-${i}`;
      if (!this.workers[k]) this.workers[k] = newWorker(`Tab ${i + 1}`);
      else this.workers[k].retired = false;
    }
    for (const k of Object.keys(this.workers)) {
      if (k.startsWith('gen-') && Number(k.slice(4)) >= n) {
        this.workers[k].retired = true;
        if (!this.workers[k].busy) this.releaseWorker(k);
      }
    }
  }

  releaseWorker(k) {
    const w = this.workers[k];
    if (!w) return;
    if (w.page) this.chrome.closePage(w.page);
    w.page = null;
    if (w.retired) delete this.workers[k];
  }

  // Generate OFF: close the managed image tabs (a tab still busy is closed when its job stops).
  releaseGenTabs() {
    for (const k of Object.keys(this.workers)) {
      if (k.startsWith('gen-') && !this.workers[k].busy) {
        const w = this.workers[k];
        if (w.page) this.chrome.closePage(w.page);
        w.page = null;
        Object.assign(w, { state: 'idle', text: '', postId: null, cooldownUntil: 0 });
      }
    }
  }

  setGenMode(mode, tabs) {
    this.store.setSetting('gen_mode', mode === 'multi' ? 'multi' : 'single');
    if (tabs !== undefined && tabs !== null) this.store.setSetting('gen_tabs', String(Math.max(MIN_TABS, Math.min(MAX_TABS, Math.round(Number(tabs) || 5)))));
    this.syncGenWorkers();
    this.log.info(`Image generation: ${this.genMode() === 'multi' ? `${this.genTabs()} tabs in parallel` : 'single tab'}`);
    this.emit('change');
    if (this.genEnabled()) setTimeout(() => this.runGenWorkers(), 200);
    return { ok: true, mode: this.genMode(), tabs: this.genTabs() };
  }

  get busy() { return Object.values(this.workers).some((w) => w.busy); }

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

  // Legacy "Start" (tray / restart): both switches on. resume = restart after reboot with the saved switches.
  async start({ resume = false } = {}) {
    if (!resume) {
      const g = await this.setGenerate(true);
      if (!g.ok) return g;
      return this.setUpload(true);
    }
    return this.startLoop();
  }

  stop() {
    this.store.setSetting('gen_enabled', '0');
    this.store.setSetting('upload_enabled', '0');
    this.abort.gen = true;
    this.abort.upload = true;
    this.stopLoopIfIdle();
  }

  async setGenerate(on) {
    if (on) {
      if (!this.store.listPrompts().length) return { ok: false, message: 'Add at least one prompt first.' };
      if (this.dailyQuantity() < 1) return { ok: false, message: 'Set the number of posts per day first.' };
    }
    this.store.setSetting('gen_enabled', on ? '1' : '0');
    this.abort.gen = !on; // OFF: stops the current generation and all retries right away
    this.log.info(`Generate images: ${on ? 'ON' : 'OFF'}`);
    if (!on) { this.releaseGenTabs(); this.stopLoopIfIdle(); this.emit('change'); return { ok: true }; }
    return this.startLoop();
  }

  async setUpload(on) {
    if (on && this.dailyQuantity() < 1) return { ok: false, message: 'Set the number of posts per day first.' };
    this.store.setSetting('upload_enabled', on ? '1' : '0');
    this.abort.upload = !on; // OFF: no new uploads; an upload already being published is finished safely
    this.log.info(`Auto upload to TikTok: ${on ? 'ON' : 'OFF'}`);
    if (!on) { this.stopLoopIfIdle(); this.setWorker('upload', { state: 'idle', text: '', postId: null }); return { ok: true }; }
    return this.startLoop();
  }

  async startLoop() {
    this.store.setSetting('running', this.running ? '1' : '0');
    if (!this.running) return { ok: true };
    if (this.genEnabled()) this.abort.gen = false;
    if (this.uploadEnabled()) this.abort.upload = false;
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

  // Both switches off: pause all automation (current steps finish/abort safely).
  stopLoopIfIdle() {
    this.store.setSetting('running', this.running ? '1' : '0');
    if (this.running) { this.emit('change'); return; }
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
      this.runGenWorkers();
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
    if (!w || w.busy || !this.workerEnabled(key) || !this.chrome.isConnected()) return;
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
      if (w.retired) this.releaseWorker(key);
      if (didWork && this.workerEnabled(key)) setTimeout(() => (key === 'upload' ? this.runUploadWorker() : this.runGenWorker(key)), 500);
    }
  }

  // ---------- image worker ----------
  providerPausedUntil() {
    const until = Number(this.store.getSetting(`${this.aiProvider()}_pause_until`, '0')) || 0;
    return Date.now() < until ? until : 0;
  }

  // Starts every image worker (several tabs are opened a little apart, not all at the same moment).
  runGenWorkers() {
    this.syncGenWorkers();
    return Promise.all(this.genKeys().map((k, i) => {
      const w = this.workers[k];
      if (i > 0 && !w.page && !w.busy) return new Promise((r) => setTimeout(() => r(this.runGenWorker(k)), i * 2000));
      return this.runGenWorker(k);
    }));
  }

  runGenWorker(key = 'gen-0') {
    return this.runWorker(key, () => {
      const w = this.workers[key];
      const until = this.providerPausedUntil();
      if (until) {
        // The AI's limit is per account: every tab waits until it resets.
        this.setWorker(key, { state: 'paused', postId: null, text: `${this.ai().name} image limit reached - continues automatically at ${new Date(until).toTimeString().slice(0, 5)}` });
        return null;
      }
      if (Date.now() < w.cooldownUntil) {
        this.setWorker(key, { state: 'paused', postId: null, text: 'Pausing briefly after an error' });
        return null;
      }
      // Central queue: claim a post atomically, so no two tabs ever work on the same post.
      for (let i = 0; i < 5; i++) {
        let post = this.store.nextToGenerate(Date.now());
        // Continuous generation: when every planned post has its image, plan the next day and keep going.
        if (!post && !this.store.countByStatus().scheduled && this.planNextDay()) post = this.store.nextToGenerate(Date.now());
        if (!post) break;
        if (this.store.claimForGeneration(post.id)) return post;
      }
      const waiting = this.store.countByStatus().scheduled || 0;
      this.setWorker(key, { state: 'idle', postId: null, text: waiting ? `Retrying shortly (${waiting} waiting for an image)` : 'Nothing to generate right now' });
      return null;
    }, (post) => this.generateOne(post, key));
  }

  postLog(id) {
    return {
      info: (m) => this.log.info(`[post ${id}] ${m}`),
      warn: (m) => this.log.warn(`[post ${id}] ${m}`),
      error: (m) => this.log.error(`[post ${id}] ${m}`),
    };
  }

  async generateOne(post, key = 'gen-0') {
    const id = post.id;
    const log = this.postLog(id);
    const ai = this.ai();
    const w = this.workers[key];
    const step = (s) => { this.store.updatePost(id, { step: s }); this.setWorker(key, { state: 'working', text: s, postId: id }); log.info(`[${w.name}] ${s}`); };
    this.store.updatePost(id, { status: 'generating', gen_attempts: (post.gen_attempts || 0) + 1, error: null });
    step(`Generating image in ${ai.name}`);
    let page = null;
    let keepPage = false;
    try {
      // This worker's own tab: opened once, reused for every post and retry.
      if (!w.page || w.page.isClosed()) w.page = await this.chrome.newPage();
      page = w.page;
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
        // Checked against the newest posts at that moment (other tabs may have just finished).
        isDuplicate: (x) => this.duplicateReason(x, this.store.recentContent(40), id),
        isDuplicateImage: (buf) => this.store.imageHashUsed(sha256(buf), id),
        fileBase: path.join(this.dirs.media, `post-${id}-${Date.now()}`),
        log,
        shouldAbort: () => this.abort.gen,
      });
      // Saved immediately: from here on this image is never generated again.
      this.store.updatePost(id, {
        idea: c.idea, title: c.title, caption: c.caption, hashtags: JSON.stringify(c.hashtags), image_prompt: c.prompt_sent,
        music_keywords: JSON.stringify(c.music_keywords), topic_keywords: JSON.stringify(c.topic_keywords), caption_key: captionKey(c.title, c.caption),
        image_path: c.image.file, image_hash: sha256(c.image.buffer),
        status: 'ready', next_try_at: 0, error: null, step: 'Image generated - waiting for upload',
      });
      log.info(`Image generated and saved: ${c.image.file}`);
      this.exportPost(id);
      setTimeout(() => this.runUploadWorker(), 200);
    } catch (e) {
      keepPage = await this.handleError(key, id, e, page, log);
    } finally {
      if (keepPage) w.page = null; // the tab now belongs to the "needs your attention" state
      else if (w.page && (!this.genEnabled() || w.retired || w.page.isClosed())) { await this.chrome.closePage(w.page); w.page = null; }
      this.setWorker(key, { state: w.attention ? 'attention' : 'idle', text: w.attention ? w.text : '', postId: null });
    }
  }

  // ---------- upload worker ----------
  runUploadWorker() {
    return this.runWorker('upload', () => {
      const now = Date.now();
      const tiktokMode = this.schedulingMode() === 'tiktok';
      // No upload limit of our own: if TikTok refuses a post (e.g. its own limit), the post is simply retried.
      // TikTok-based: within TikTok's scheduling window (10 days); software-based: when the posting time has come.
      const maxSlot = tiktokMode ? now + TIKTOK_DAYS_AHEAD * 86400e3 - 3600e3 : now;
      const post = this.store.nextToUpload(now, { maxSlot });
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
        shouldAbort: () => this.abort.upload,
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
    const gen = key !== 'upload';
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
    if (gen && this.workers[key] && (e instanceof ChromeUnavailableError || BROWSER_GONE_RE.test(e.message))) this.workers[key].page = null;
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
    // Recoverable: retried on its own timer (at once, then 15 s, 30 s, max 1 min); other posts continue meanwhile.
    const delay = retryDelayMs(attempts);
    this.store.updatePost(id, { status: back, next_try_at: now + delay, error: msg });
    if (gen && this.workers[key]) {
      // This tab pauses briefly (the others continue) and then retries in the same tab.
      const pause = Math.max(5000, delay);
      this.workers[key].cooldownUntil = now + pause;
      setTimeout(() => this.runGenWorker(key), pause + 200);
    }
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

  // Continuous generation: adds the next not-yet-planned day (after the last planned one) to the queue.
  planNextDay() {
    const now = Date.now();
    const last = this.store.lastPlannedDay();
    const base = last ? new Date(`${last}T12:00:00`) : new Date(now);
    if (last) base.setDate(base.getDate() + 1);
    if (base.getTime() - now > MAX_QUEUE_DAYS * 86400e3) return false;
    const day = dayKey(base);
    const posts = this.store.postsForDay(day);
    const active = posts.filter((p) => ACTIVE_STATUSES.includes(p.status));
    const plan = planDay({ day, target: this.dailyQuantity(), existingActive: active, totalAttempts: posts.length, now });
    for (const t of plan.add) this.store.createPost(day, t);
    if (plan.add.length) this.log.info(`Queue: planned ${plan.add.length} posts for ${day} (continuous generation).`);
    return plan.add.length > 0;
  }

  // Saves every generated post to the Export folder: image + caption, hashtags, posting date and other data.
  exportPost(id) {
    if (!this.dirs.export) return;
    try {
      const p = this.store.getPost(id);
      fs.mkdirSync(this.dirs.export, { recursive: true });
      const when = new Date(p.slot_at || p.scheduled_at);
      const stamp = `${dayKey(when)}_${String(when.getHours()).padStart(2, '0')}${String(when.getMinutes()).padStart(2, '0')}`;
      const base = path.join(this.dirs.export, `${stamp}_post-${id}`);
      fs.copyFileSync(p.image_path, `${base}${path.extname(p.image_path)}`);
      const hashtags = p.hashtags ? JSON.parse(p.hashtags) : [];
      const data = {
        id, postingDate: when.toISOString(), postingDateLocal: when.toLocaleString(), title: p.title, caption: p.caption, hashtags,
        idea: p.idea, prompt: p.prompt_text, musicKeywords: p.music_keywords ? JSON.parse(p.music_keywords) : [],
        image: path.basename(`${base}${path.extname(p.image_path)}`), generatedAt: new Date().toISOString(),
      };
      fs.writeFileSync(`${base}.json`, JSON.stringify(data, null, 2));
      fs.writeFileSync(`${base}.txt`, `${p.title || ''}\n\n${p.caption}\n\n${hashtags.join(' ')}\n\nPosting date: ${when.toLocaleString()}\n`);
    } catch (e) {
      this.log.warn(`[post ${id}] Export failed: ${e.message}`);
    }
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

  // One line for all image tabs (the dashboard also lists every tab).
  genSummary() {
    const ws = this.genKeys().map((k) => this.workers[k]);
    const working = ws.filter((w) => w.state === 'working').length;
    const state = ws.some((w) => w.attention) ? 'attention' : working ? 'working' : ws.length && ws.every((w) => w.state === 'paused') ? 'paused' : 'idle';
    const text = ws.length > 1 ? `${working} of ${ws.length} tabs generating` : (ws[0] ? ws[0].text : '');
    return { state, text, postId: ws.length === 1 && ws[0] ? ws[0].postId : null, busy: ws.some((w) => w.busy), attention: ws.some((w) => w.attention) };
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
      workers: { gen: this.genSummary(), upload: worker(this.workers.upload) },
      genTabs: this.genKeys().map((k) => ({ key: k, ...worker(this.workers[k]) })),
      genMode: { mode: this.genMode(), tabs: this.genTabs(), active: this.genKeys().length },
      queue: { waitingForImage: counts.scheduled || 0, generating: counts.generating || 0, ready: counts.ready || 0, uploading: (counts.uploading || 0) + (counts.posting || 0) },
      switches: { generate: this.genEnabled(), upload: this.uploadEnabled() },
      overview: {
        imagesGenerated: this.store.countImagesGenerated(),
        pendingUpload: counts.ready || 0,
        scheduledOnTikTok: this.store.countFutureTikTokScheduled(Date.now()),
        published: this.store.stats(today).totalPublished,
        publishedToday: this.store.stats(today).todayPublished,
      },
      exportDir: this.dirs.export || null,
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
