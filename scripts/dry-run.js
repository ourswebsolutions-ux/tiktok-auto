'use strict';
// Runs the complete pipeline in your everyday Chrome but STOPS right before clicking "Post":
// ChatGPT content -> ChatGPT image -> TikTok upload -> sound -> caption/hashtags -> AI label -> verification.
// The TikTok tab is then closed, which discards the draft. Nothing is published.
//
//   npm run dry-run -- "your prompt"                 (full run, uses one ChatGPT image generation)
//   npm run dry-run -- --image path/to/image.png     (skip image generation, use an existing image)
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ChromeConnection } = require('../src/main/automation/chrome');
const chatgpt = require('../src/main/automation/chatgpt');
const tiktok = require('../src/main/automation/tiktok');

class DryRunStop extends Error {}

(async () => {
  const args = process.argv.slice(2);
  const imgIdx = args.indexOf('--image');
  const existingImage = imgIdx >= 0 ? path.resolve(args[imgIdx + 1]) : null;
  const userPrompt = args.filter((a, i) => imgIdx < 0 || (i !== imgIdx && i !== imgIdx + 1)).join(' ')
    || 'Short motivational posts for young entrepreneurs, cinematic and moody visuals';
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
    const content = await chatgpt.generateContent(page, { userPrompt, recent: [], isDuplicate: () => null, log });
    log.info(`ChatGPT content: ${JSON.stringify(content, null, 1)}`);
    let imagePath = existingImage;
    if (!imagePath) {
      log.info('Generating image in ChatGPT (can take 1-3 minutes)...');
      const img = await chatgpt.generateImage(page, { imagePrompt: content.image_prompt, fileBase: path.join(outDir, 'image') });
      imagePath = img.file;
      log.info(`Image saved: ${img.file} (${img.width}x${img.height}, ${img.buffer.length} bytes)`);
    }
    const post = {
      image_path: imagePath, title: content.title, caption: content.caption, hashtags: JSON.stringify(content.hashtags),
      music_keywords: JSON.stringify(content.music_keywords), topic_keywords: JSON.stringify(content.topic_keywords),
    };
    try {
      await tiktok.publishPhotoPost(page, post, {
        log, recentSounds: [], onProgress: (s) => log.info(`TikTok: ${s}`),
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
