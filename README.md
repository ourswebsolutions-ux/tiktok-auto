# TikTok Auto Poster

Add prompts → set posts per day → **Start Automation**. For every scheduled post the app works inside **your own
everyday Chrome** (your existing logins):

1. opens **ChatGPT** and sends **your prompt exactly as you wrote it** – nothing is added or changed, so if your prompt
   asks for text on the image, a style, a language etc., ChatGPT gets exactly that – and saves the generated **image**,
2. in the same chat asks ChatGPT for a title, caption, hashtags and music keywords **for that image** (following your
   prompt if it says anything about captions/hashtags; checked against earlier posts so nothing repeats),
3. opens **TikTok Studio** and uploads the image as a photo post,
4. picks a **relevant, popular sound** (see below) and attaches it,
5. enters title, caption and hashtags, switches on TikTok's *AI-generated content* label and verifies everything,
6. clicks **Post** and only counts the post as published once it appears in your TikTok Studio *Posts* list.

No API keys, no paid integrations, no passwords stored.

## Download

Get the latest version from **[Releases](https://github.com/ourswebsolutions-ux/tiktok-auto/releases/latest)**:

| System | File | Install |
| --- | --- | --- |
| Windows 10/11 | `TikTok-Auto-Poster-<version>-win-x64.exe` | Run it (one-click installer). Windows SmartScreen may warn because the app isn't code-signed: *More info → Run anyway*. |
| Linux (x64) | `TikTok-Auto-Poster-<version>-linux-x86_64.AppImage` | `chmod +x TikTok-Auto-Poster-*.AppImage` then run it. Needs `libfuse2` (`sudo apt install libfuse2`). |

### Automatic updates

Installed apps check GitHub for a new release on start-up and **every minute**. A new version is downloaded in the
background and installed automatically **as soon as the automation is idle** (never in the middle of a post); the app
restarts and continues where it left off. The current version and update status are shown at the top of the dashboard,
and the tray menu has *Check for Updates*.

## Connect your everyday Chrome (one-time)

The app **never launches its own browser and never creates a profile**. It connects to the Chrome you already use via
the DevTools protocol (Playwright `connectOverCDP`, port **9222**) and works in new tabs that it opens and closes
itself. Your other tabs, profile data and cookies are never touched, read or exported.

Use either option:

- **Recommended:** in Chrome open `chrome://inspect/#remote-debugging` and turn on **Allow remote debugging**. When the
  app connects, Chrome asks *"Allow remote debugging?"* – click **Allow**. This prompt is Chrome's own security
  protection for your everyday profile and cannot be turned off by any app. The app opens **one** connection and keeps
  it, so you are asked only when the app (re)starts – e.g. after booting or an update – or after Chrome was restarted,
  never for each post.
- or start Chrome with the flag `--remote-debugging-port=9222` (note: recent Chrome versions ignore this flag for the
  default profile, so the option above is usually needed).

Then make sure you are logged in to **chatgpt.com** and **tiktok.com** in that Chrome. Press *Check Chrome connection*
in the dashboard to verify. If Chrome isn't reachable, the app shows these instructions instead of doing anything.

> While remote debugging is enabled, any program on your computer can control that Chrome. Only enable it on a
> computer you trust.

## Using it

1. Add one or more prompts (used in rotation). Write them exactly as you would type them into ChatGPT, e.g.
   *"Create a vertical 9:16 image with a short motivational quote in bold white text on a cinematic background."*
   Each post sends the prompt again in a new chat, so ChatGPT creates a new image every time.
2. Set **Posts per day** (1–20).
3. Press **Start Automation**.

Posting times are calculated automatically across the **full 24 hours** – no fixed posting hours. Example: 6 posts a
day ≈ one post every 4 hours (with a little randomness), at least 25 minutes apart. Starting in the middle of the day
spreads the remaining posts over the remaining hours. Failed posts are retried
(up to 3 attempts); a completely failed post gets a replacement slot (capped, so it can't loop).

Closing the window keeps the automation running in the background (tray icon: Open / Start / Stop / Check for Updates /
Quit). The app starts hidden when you log in to your computer and resumes the remaining posts of the day.
On GNOME, tray icons need the *AppIndicator* extension (`sudo apt install gnome-shell-extension-appindicator`).

## Image & caption: ChatGPT or Gemini

A switch on the dashboard selects which website creates the image and the caption: **ChatGPT** (chatgpt.com) or
**Gemini** (gemini.google.com). Both work the same way in your own logged-in Chrome: your prompt is sent exactly as
written in a new chat, the image is captured (regenerated automatically if it fails), then the title, caption,
hashtags and music keywords are written for that image. Each website's own image limit is detected and waited out.

## Scheduling: Software-Based or TikTok-Based

A switch on the dashboard selects how posts are scheduled. Content generation, posts per day and the calculated
posting times are the same in both modes, and automation runs continuously until you press **Stop**.

- **Software-Based** (default): the app publishes each post itself at its calculated time.
- **TikTok-Based**: the app generates and uploads the upcoming posts one by one right away and sets each one's time in
  TikTok's own *When to post → Schedule* option, so TikTok publishes them – even if the computer is off at that time.
  It keeps the **next 10 days** scheduled (TikTok does not allow scheduling further ahead) and adds a new day every
  day, so it keeps going all year as long as the app runs. Example: 12 posts/day = 120 posts queued on TikTok.
  TikTok needs a schedule time at least ~15 minutes ahead in 5-minute steps, so a time that is too close is moved to
  20 minutes from now and times are rounded up to the next 5 minutes. The history shows these posts as
  *Scheduled on TikTok*; they count as published once their time has passed. The first time, TikTok asks once to allow
  saving posts for scheduled posting – the app confirms that dialog.

## Automatic retries

- If ChatGPT shows an error ("Something went wrong", "Try again", no image), the app immediately asks it to
  regenerate the image – up to 6 times – instead of waiting. Only a real usage-limit message pauses image creation
  (re-checked every 30 minutes).
- A failed post or upload is retried automatically after 1, 2, 5, 10 and 15 minutes (up to 6 attempts); other posts
  keep going meanwhile. If a post still fails, a replacement post is scheduled for that day.

## How the music is chosen

TikTok's sound picker loads TikTok's own data for every sound, including **how many videos use it**. The app reads that
data (exactly what the picker loads) and:

- searches the sound library with mood/genre keywords ChatGPT suggested for the post, plus the sounds TikTok recommends
  for the uploaded photo,
- keeps only sounds with a verifiable usage count of at least 10,000 videos that weren't used recently,
- ranks by relevance first (search match, TikTok's photo recommendation, keyword overlap), then by usage count,
- attaches the best one; if it can't be found or attached, tries the next.

The history shows the sound and its evidence, e.g. *"Used in 294.2K TikTok videos"*. Sounds are never called
"trending" because TikTok doesn't expose rank-over-time data on the web. If nothing relevant with verifiable popularity
can be attached, the post goes out without an added sound – never a random one.

## Safety and reliability

- Every step is checked before the next; on any unexpected page nothing is published (logged with a screenshot).
- A post is marked *Publishing* right before clicking Post. After a crash, restart or error from that point on, the app
  first checks your TikTok Posts list and never re-posts blindly. Captions are unique in the database.
- Ideas, captions, image concepts, hashtag sets, images and sounds are compared with earlier posts to avoid repeats.
- **CAPTCHAs, logins and security checks are never bypassed:** the app pauses, brings the tab to the front and notifies
  you. After a CAPTCHA disappears it continues automatically; after logging in press **Resume**.
- If Chrome is closed or crashes, the app waits and reconnects when Chrome is back.

## Limits

- **ChatGPT Free** allows only a few image generations per day. When the limit is hit the post is retried ~90 minutes
  later; posts that can't be made before midnight are marked *Missed*. Several posts a day realistically need a paid
  ChatGPT plan.
- Each post creates one chat in your ChatGPT history (temporary chats can't generate images).
- Hashtags come from ChatGPT; TikTok doesn't expose hashtag popularity in the upload editor.
- Automation runs only while the computer is on and awake. TikTok's limits and community guidelines apply to your
  account – you are responsible for what you publish.
- If ChatGPT or TikTok change their websites, the affected step fails safely; update to the latest release.

## Data

Stored per user (`~/.config/tiktok-auto-poster/` on Linux, `%APPDATA%\tiktok-auto-poster\` on Windows):
`app.db` (SQLite: prompts, schedule, history), `media/` (generated images), `logs/`, `screenshots/` (failed steps).

## Development

```bash
git clone https://github.com/ourswebsolutions-ux/tiktok-auto.git
cd tiktok-auto
npm install
npm start              # run from source
npm test               # unit tests
npm run check-chrome   # verify Chrome connection + ChatGPT/TikTok logins (read-only)
npm run dry-run -- "your prompt"   # full pipeline, stops right before clicking Post
npm run dist           # build installers locally into release/
```

### Publishing a new version (auto-update for everyone)

1. Bump `version` in `package.json` (e.g. `1.0.1`) and commit.
2. `git tag v1.0.1 && git push origin main --tags`
3. GitHub Actions (`.github/workflows/release.yml`) builds Windows + Linux and publishes the release. Installed apps
   update themselves within a few hours.

## License

MIT
