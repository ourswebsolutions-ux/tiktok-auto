'use strict';
// Verifies the connection to your everyday Chrome and that ChatGPT + TikTok are reachable and logged in.
// Read-only: it opens two tabs, inspects them, and closes only those two tabs. Nothing is sent or posted.
//   npm run check-chrome
const { ChromeConnection } = require('../src/main/automation/chrome');
const { checkChatGPT } = require('../src/main/automation/chatgpt');
const { checkTikTok } = require('../src/main/automation/tiktok');

(async () => {
  const log = { info: (m) => console.log('  ', m), warn: (m) => console.log('  !', m), error: (m) => console.log('  x', m) };
  const chrome = new ChromeConnection({ log });
  const probe = await chrome.probe();
  if (!probe.available) {
    console.log(`Chrome debugging NOT available: ${probe.reason}\n\n${probe.instructions}`);
    process.exit(2);
  }
  console.log(`Debugging endpoint found (${probe.mode}). Connecting...`);
  let ok = true;
  try {
    await chrome.connect();
    const ctx = await chrome.context();
    console.log(`Connected. Existing tabs in your profile: ${ctx.pages().length}`);
    for (const [name, fn] of [['ChatGPT', checkChatGPT], ['TikTok', checkTikTok]]) {
      const page = await chrome.newPage();
      try {
        const r = await fn(page);
        console.log(`${name}: ${r.ok ? 'OK' : 'PROBLEM'} - ${r.detail}`);
        ok = ok && r.ok;
      } catch (e) {
        ok = false;
        console.log(`${name}: ERROR - ${e.message}`);
      } finally {
        await chrome.closePage(page);
      }
    }
  } catch (e) {
    ok = false;
    console.log(`Connection failed: ${e.message}`);
  }
  // Exit without closing the browser (the process exit just drops the debugging connection).
  process.exit(ok ? 0 : 1);
})();
