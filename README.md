# Mess Board — push reminders

Two pushes per meal: a **planning push** (night before for breakfast,
same-day for lunch/dinner) that opens the app to a menu comparison across
every hall — halls with any never-eat item dropped, halls with your
favorites surfaced first — where you tap to pick a hall; then a **confirm
push** near meal time ("ready for idli and vada at Hall 4?") reflecting
whatever you picked. If you don't pick in time, it auto-falls-back to its
best guess based on your taste tags.

**Cost: ₹0.** Everything below runs on free tiers (Cloudflare Workers, GitHub
Actions, GitHub Pages).

Honest limitation: GitHub Actions cron isn't millisecond-precise — it can run
a few minutes late when GitHub is busy. Fine for "remind me around lunchtime",
not fine if you need second-level precision.

---

## What you're setting up

1. **The PWA** (repo root — `index.html`, `sw.js`, `config.js`, `manifest.json`)
   — the installable app itself, hosted for free on GitHub Pages. Note it
   lives at the repo root, not in a `pwa/` subfolder — GitHub Pages on the
   free plan only serves `/` or `/docs`, not arbitrary subfolders.
2. **The Worker** (`worker/`) — a tiny Cloudflare Worker that stores your
   subscription (preferences, reminder/plan times) and your daily hall picks
   in a free KV database. See `worker/subscribe-worker.js` for the exact
   routes and KV key scheme.
3. **The Action** (`.github/workflows/reminders.yml` + `actions/`) — runs
   every 5 minutes, checks if it's time to send a planning or confirm push
   for any subscriber, and sends it.

---

## Step 1 — Generate VAPID keys

VAPID keys let push services (like Chrome's) verify the notification really
came from you. Generate them once, on your own machine:

```bash
npx web-push generate-vapid-keys
```

This prints a public key and a private key. **Keep the private key secret** —
you'll paste it into GitHub Actions secrets (step 4), never into the Worker or
the PWA.

---

## Step 2 — Deploy the Cloudflare Worker

1. Create a free account at https://dash.cloudflare.com if you don't have one.
2. Install Wrangler (Cloudflare's CLI) and log in:
   ```bash
   npm install -g wrangler
   wrangler login
   ```
3. From the `worker/` folder, create the KV namespace:
   ```bash
   cd worker
   wrangler kv namespace create MESS_SUBS
   ```
   This prints an `id`. Paste it into `wrangler.toml`, replacing
   `PASTE_KV_NAMESPACE_ID_HERE`.
4. Set the admin secret (make up any long random string — you'll reuse it in step 4):
   ```bash
   wrangler secret put ADMIN_SECRET
   ```
5. Deploy:
   ```bash
   wrangler deploy
   ```
   This prints your Worker's URL, like `https://mess-push.yourname.workers.dev`.
   Save it — you need it in steps 3 and 4.

---

## Step 3 — Configure and host the PWA

1. Open `config.js` (repo root) and fill in:
   ```js
   window.MESS_CONFIG = {
     WORKER_URL: "https://mess-push.yourname.workers.dev",   // from step 2
     VAPID_PUBLIC_KEY: "...your public key from step 1..."
   };
   ```
2. Push the whole `mess-pwa` folder to a new GitHub repo.
3. In the repo: **Settings → Pages → Deploy from branch**, pick `master`
   (or `main`) and `/` (root) — GitHub Pages on the free plan only supports
   `/` or `/docs`, so the PWA files live at the repo root, not a subfolder.
4. Your app will be live at something like
   `https://yourusername.github.io/mess-pwa/`. Open it on your phone in
   Chrome, tap "Add to Home Screen," then open the installed app, set your
   taste tags and pick/reminder times, and hit **Enable push reminders**.

---

## Step 4 — Add GitHub Actions secrets

In your repo: **Settings → Secrets and variables → Actions → New repository secret.**
Add all of these:

| Secret name | Value |
|---|---|
| `WORKER_URL` | Your Worker URL from step 2 |
| `ADMIN_SECRET` | The same string you set in step 2.4 |
| `VAPID_PUBLIC_KEY` | From step 1 |
| `VAPID_PRIVATE_KEY` | From step 1 |
| `VAPID_SUBJECT` | `mailto:youremail@example.com` (any contact email) |

The workflow in `.github/workflows/reminders.yml` starts running automatically
once these are set (GitHub Actions schedules activate as soon as the workflow
file is on the default branch). You can also trigger it manually from the
**Actions** tab → "Mess reminders" → **Run workflow**, to test immediately
without waiting for the clock.

---

## How a reminder actually reaches you

1. Every 5 minutes, GitHub spins up a throwaway machine and runs `send-reminders.js`.
2. It asks your Worker for the list of subscribers (just you, most likely)
   and for any hall picks already saved for today.
3. For each subscriber, it checks two things against the current IST time:
   - **Planning time** (`planTimes.Lunch`/`Dinner`, or 21:00 the night
     before for breakfast if `nightBeforePlan` is on): sends a teaser push
     ("Hall 6 has your favorite chole bhature — tap to pick") that deep-links
     into the PWA's picker screen at `index.html?pick=<meal>&date=<date>`.
   - **Confirm time** (`times.Breakfast`/`Lunch`/`Dinner`): looks up whatever
     hall was picked for that meal + date via the Worker's `/picks` route,
     fetches that hall's menu from `campusmess.in`, and sends the "ready for
     X at Hall Y?" push. If nothing was picked, it auto-picks the
     best-matching hall instead and says so.
4. Either way, delivery goes through the `web-push` library straight to
   Chrome's push service on your phone — no tab or app needs to be open.

Special-item pre-booking (items bookable a day in advance) isn't wired up
yet — `fetchSpecialBookings()` in `index.html` is a stub pending a HAR
capture of that flow from campusmess.in.

---

## Files in this project

```
index.html, sw.js, manifest.json, config.js, icon-*.png   the installable PWA (repo root)
worker/         Cloudflare Worker source + config
actions/        the Node script GitHub Actions runs on schedule
.github/workflows/reminders.yml   the schedule itself
```
