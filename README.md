# Mess Board — push reminders

Sends you a real push notification (works with the app/tab closed) at times you
choose, telling you what's on the menu at your hall and whether it matches
your taste — plus an optional night-before heads-up.

**Cost: ₹0.** Everything below runs on free tiers (Cloudflare Workers, GitHub
Actions, GitHub Pages).

Honest limitation: GitHub Actions cron isn't millisecond-precise — it can run
a few minutes late when GitHub is busy. Fine for "remind me around lunchtime",
not fine if you need second-level precision.

---

## What you're setting up

1. **The PWA** (`pwa/`) — the installable app itself. Hosted for free on GitHub Pages.
2. **The Worker** (`worker/`) — a tiny Cloudflare Worker that stores your
   subscription (hall, preferences, reminder times) in a free KV database.
3. **The Action** (`.github/workflows/reminders.yml` + `actions/`) — runs
   every 5 minutes, checks if it's time to notify you, and sends the push.

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

1. Open `pwa/config.js` and fill in:
   ```js
   window.MESS_CONFIG = {
     WORKER_URL: "https://mess-push.yourname.workers.dev",   // from step 2
     VAPID_PUBLIC_KEY: "...your public key from step 1..."
   };
   ```
2. Push the whole `mess-pwa` folder to a new GitHub repo.
3. In the repo: **Settings → Pages → Deploy from branch**, pick `main` and the
   `/pwa` folder (or move `pwa/`'s contents to the repo root if GitHub Pages
   on your plan doesn't support subfolder deploys — either works).
4. Your app will be live at something like
   `https://yourusername.github.io/mess-pwa/`. Open it on your phone in
   Chrome, tap "Add to Home Screen," then open the installed app and hit
   **Enable push reminders**.

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
2. It asks your Worker for the list of subscribers (just you, most likely).
3. For each one, it checks: does the current time (IST) match any of your
   saved reminder times?
4. If yes, it calls `campusmess.in`'s public API for that hall + meal, checks
   the description against your liked/disliked words, and sends a push via
   the `web-push` library — which delivers it through Chrome's push service
   straight to your phone, no matter whether the tab or app is open.

---

## Files in this project

```
pwa/            the installable app (index.html, sw.js, manifest.json, icons)
worker/         Cloudflare Worker source + config
actions/        the Node script GitHub Actions runs on schedule
.github/workflows/reminders.yml   the schedule itself
```
