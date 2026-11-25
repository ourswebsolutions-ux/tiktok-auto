# TikTok Auto Poster

Add prompts → set posts per day → **Start Automation**. For every scheduled post the app (inside your own everyday Chrome):

1. opens **ChatGPT** and generates a fresh idea, title, caption, hashtags and a detailed image prompt (checked against earlier posts so nothing repeats),
2. generates the **image** with ChatGPT's image generation and saves it locally,
3. opens **TikTok Studio**, uploads the image as a photo post,
4. picks a **relevant, popular sound** (see below) and attaches it,
5. enters title, caption and hashtags, switches on TikTok's *AI-generated content* label, verifies everything,
6. clicks **Post** and only counts the post as published once it appears in your TikTok Studio *Posts* list.

## Requirements

- Node.js 22+ and npm
- Google Chrome (your normal, everyday Chrome) with remote debugging on port **9222**
- You are logged in to chatgpt.com and tiktok.com in that Chrome

## Install

```bash
cd "/media/ali/New Volume2/tiktok-automaticon"
npm install
```

## Connect your everyday Chrome

The app **never launches its own browser and never creates a profile**. It connects to the Chrome you already use
(with Playwright `connectOverCDP`) and works in new tabs it opens and closes itself. Your other tabs, profile data and
cookies are never touched, read or exported.

Either of these works:

- **Your shortcut** that starts Chrome with `--remote-debugging-port=9222`, or
- in your Chrome open `chrome://inspect/#remote-debugging` and turn on **Allow remote debugging**
  (this is how your Chrome is currently set up; Chrome then shows an *"Allow remote debugging?"* prompt the first
  time the app connects – click **Allow**. The app keeps one connection open so you are not asked for every post).

Check the connection at any time:

```bash
npm run check-chrome
```

Expected output:

```
Connected. Existing tabs in your profile: N
ChatGPT: OK - reachable and logged in
TikTok: OK - TikTok Studio upload page reachable and logged in
```

If Chrome isn't reachable, the app shows these instructions instead of starting anything.

## Start the app

```bash
npm start          # builds the dashboard and opens it
```

- Closing the window only hides it – automation keeps running in the background (tray icon: Open / Start / Stop / Quit).
  Running `npm start` again just brings the window back.
- On first launch the app registers itself to start automatically (hidden) when you log in
  (`~/.config/autostart/tiktok-auto-poster.desktop`). If it was running before shutdown, it resumes the remaining posts
  for today. Delete that file to disable auto-start.
- GNOME note: GNOME only shows tray icons with the *AppIndicator* extension
  (`sudo apt install gnome-shell-extension-appindicator`, then log out/in). Without it the app still runs; use
  `npm start` to open the dashboard.

## Using it

1. Add one or more prompts (they're used in rotation).
2. Set **Posts per day** (1–20).
3. Press **Start Automation**.

Posting times are calculated automatically: spread evenly with a little randomness between 08:00 and 23:00, at least
25 minutes apart. If you start late in the day, the remaining posts are fitted into the remaining time. Failed posts
are retried (up to 3 attempts) and, if a post fails completely, a replacement slot is added (capped so it can't loop).

## How the music is chosen

TikTok's sound picker loads TikTok's own data for every sound, including **how many videos use it**. The app reads that
data (the same data the picker shows) and:

- searches the sound library with the mood/genre keywords ChatGPT suggested for the post, and includes the sounds
  TikTok recommends for the uploaded photo,
- keeps only sounds with a verifiable usage count of at least 10,000 videos that you haven't used recently,
- ranks by relevance first (search match, TikTok's photo recommendation, keyword overlap), then by usage count,
- attaches the best one, and if it can't be found or attached, tries the next.

The history shows the chosen sound and its evidence, e.g. *"Used in 5.3M TikTok videos"*. The app does not label a
sound "trending" because TikTok doesn't expose rank-over-time data on the web. If no relevant sound with verifiable
popularity can be attached, the post goes out without an added sound (never a random one).

## Safety and reliability

- Every step is checked before the next one; on any unexpected page the post is **not** published.
- The post is marked *Publishing* in the database right before clicking Post. After a crash, restart or any error from
  that point on, the app first checks your TikTok Posts list and never re-posts blindly.
- Captions are unique in the database; ideas, captions, image concepts, hashtag sets, image files and sounds are
  compared with earlier posts to avoid repeats.
- **CAPTCHA / login / security checks** are never bypassed: the app pauses, brings the tab to the front and shows a
  notice. After a CAPTCHA disappears it continues automatically; after logging in press **Resume**.
- If Chrome is closed or crashes, the app waits and reconnects when Chrome (with debugging) is back.
- ChatGPT runs in normal chats (temporary chats can't generate images), so each post creates one chat in your ChatGPT history.

## Files

Everything is stored in `~/.config/tiktok-auto-poster/`:

| Path | Content |
| --- | --- |
| `app.db` | SQLite: prompts, settings, schedule, history |
| `media/` | generated images |
| `logs/app-YYYY-MM-DD.log` | step-by-step logs |
| `screenshots/` | screenshots of failed steps |

## Limits to be aware of

- **ChatGPT Free** allows only a few image generations per day. When the limit is hit the post is postponed ~90 minutes
  and retried; posts that can't be made before midnight are marked *Missed*. For several posts a day, a paid ChatGPT
  plan is realistically needed.
- Hashtags come from ChatGPT; TikTok doesn't expose hashtag popularity in the upload editor.
- While remote debugging is enabled, any program on this computer can control that Chrome. Only enable it on a
  computer you trust, and turn it off when you don't need the automation.
- Automation runs only while the computer is on and awake. TikTok's own limits and rules apply to your account.
- If ChatGPT or TikTok change their pages, the affected step fails safely (logged with a screenshot) instead of posting
  something wrong.

## Development

```bash
npm test           # unit tests (scheduler, parsing, sound ranking, duplicate guard, crash recovery)
npm run build      # build the dashboard only
```
