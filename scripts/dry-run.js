'use strict';
// Runs the complete pipeline in your everyday Chrome but STOPS right before clicking "Post":
// your prompt (sent to ChatGPT exactly as written) -> image -> caption/hashtags -> TikTok upload -> sound -> AI label -> verification.
// The TikTok tab is then closed, which discards the draft. Nothing is published.
//
//   npm run dry-run -- "your prompt"     (uses one ChatGPT image generation)
//   options: --tiktok-schedule  also fill in TikTok's own Schedule date/time (TikTok-Based mode), ~2 hours ahead
//            --days-ahead <n>   with --tiktok-schedule: schedule n days later (max 9)
//            --gemini           create image + caption with Gemini instead of ChatGPT
//            --image <file>     skip ChatGPT and use an existing image with sample caption (tests the TikTok part only)
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ChromeConnection } = require('../src/main/automation/chrome');
const chatgpt = require('../src/main/automation/chatgpt');
const gemini = require('../src/main/automation/gemini');
const tiktok = require('../src/main/automation/tiktok');

class DryRunStop extends Error {}

(async () => {
  const args = process.argv.slice(2);
  const take = (flag, withValue) => { const i = args.indexOf(flag); if (i < 0) return null; const v = withValue ? args[i + 1] : true; args.splice(i, withValue ? 2 : 1); return v; };
  const tiktokSchedule = !!take('--tiktok-schedule', false);
  const existingImage = take('--image', true);
  const useGemini = !!take('--gemini', false);
  const daysAhead = Number(take('--days-ahead', true) || 0);
  const userPrompt = args.join(' ')
    || 'Create a vertical 9:16 motivational image with the text "Start before you are ready" in bold white letters on a cinematic sunrise background.';
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tiktok-dry-run-'));
  const t0 = Date.now();
  const log = {
    info: (m) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0)}s] ${m}`),
    warn: (m) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0)}s] WARN ${m}`),
    error: (m) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0)}s] ERROR ${m}`),
  };
  const chrome = new ChromeConnection({ log });
  let page;
  let code = 0;
  try {
    page = await chrome.newPage();
    log.info(`Prompt: ${userPrompt}`);
    const content = existingImage
      ? { image: { file: path.resolve(existingImage) }, title: 'Dry run test post', caption: 'Testing the automation flow, this is not published.', hashtags: ['#test', '#dryrun', '#automation'], music_keywords: ['calm piano'], topic_keywords: ['test'] }
      : await (useGemini ? gemini : chatgpt).generatePost(page, {
        userPrompt, recent: [], isDuplicate: () => null, isDuplicateImage: () => false, fileBase: path.join(outDir, 'image'), log,
      });
    const { image, ...details } = content;
    log.info(`Post details: ${JSON.stringify(details, null, 1)}`);
    const post = {
      image_path: image.file, title: content.title, caption: content.caption, hashtags: JSON.stringify(content.hashtags),
      music_keywords: JSON.stringify(content.music_keywords), topic_keywords: JSON.stringify(content.topic_keywords),
    };
    try {
      await tiktok.publishPhotoPost(page, post, {
        log, recentSounds: [], onProgress: (s) => log.info(`TikTok: ${s}`),
        scheduleAt: tiktokSchedule ? tiktok.tiktokScheduleTime(Date.now() + daysAhead * 86400e3 + 2 * 3600e3) : null,
        beforePost: async (sound) => {
          log.info(`Sound: ${sound ? `${sound.title} | ${sound.evidence}` : 'none attached'}`);
          await page.screenshot({ path: path.join(outDir, 'ready-to-post.png'), fullPage: true });
          throw new DryRunStop();
        },
      });
      log.error('Unexpected: flow reached publishing in a dry run');
      code = 1;
    } catch (e) {
      if (!(e instanceof DryRunStop)) throw e;
      log.info(`DRY RUN OK - everything verified, stopped before clicking Post. Screenshot: ${path.join(outDir, 'ready-to-post.png')}`);
    }
  } catch (e) {
    code = 1;
    log.error(`${e.name}: ${e.message}`);
    if (page) await page.screenshot({ path: path.join(outDir, 'error.png') }).catch(() => {});
    log.error(`Screenshot: ${path.join(outDir, 'error.png')}`);
  } finally {
    await chrome.closePage(page); // discards the unsaved TikTok draft
  }
  process.exit(code);
})();
