// Runs on a schedule via GitHub Actions (every 5 minutes).
//
// Two kinds of push per meal:
//   - "planning" push: fires at planTimes.Lunch / planTimes.Dinner (same day)
//     or, for breakfast, at a fixed 21:00 IST the night before (if the
//     subscriber has nightBeforePlan on). Teases the best-matching hall and
//     deep-links into the PWA's picker screen (index.html?pick=<meal>&date=...).
//   - "confirm" push: fires at times.Breakfast/Lunch/Dinner. Reads back
//     whatever hall the subscriber picked (via the Worker's /picks) for
//     that service date + meal, and sends the "ready for X at Hall Y?"
//     message. Falls back to auto-picking the best hall if nothing was
//     picked in time.

const webpush = require('web-push');

const WORKER_URL = process.env.WORKER_URL;
const ADMIN_SECRET = process.env.ADMIN_SECRET;
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:example@example.com';

webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

function istNow() {
  // IST = UTC+5:30, no DST
  const now = new Date();
  return new Date(now.getTime() + (5.5 * 60 + now.getTimezoneOffset()) * 60000);
}

function hhmm(d) {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function dayName(d) {
  return d.toLocaleDateString('en-US', { weekday: 'long' });
}

function isoDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// ---- shared menu-matching logic (kept in sync with index.html) ----
function splitItems(desc) {
  if (!desc) return [];
  return desc.split(/[,\/]| with | and /i).map(s => s.trim()).filter(Boolean);
}

function verdictFor(desc, prefs) {
  const items = splitItems(desc);
  const liked = items.filter(i => (prefs.liked || []).some(p => p && i.toLowerCase().includes(p.toLowerCase())));
  const disliked = items.filter(i => (prefs.disliked || []).some(p => p && i.toLowerCase().includes(p.toLowerCase())));
  if (disliked.length && !liked.length) return { tag: 'skip', liked, disliked };
  if (liked.length) return { tag: 'go', liked, disliked };
  return { tag: 'meh', liked, disliked };
}

function bestHallFor(halls, prefs) {
  const scored = halls
    .map(h => ({ h, verdict: verdictFor(h.currentMenu ? h.currentMenu.description : '', prefs || {}) }))
    .filter(s => s.verdict.tag !== 'skip');
  if (!scored.length) return null;
  scored.sort((a, b) => (a.verdict.tag === 'go' ? 0 : 1) - (b.verdict.tag === 'go' ? 0 : 1));
  return scored[0].h;
}

const hallsCache = new Map();
async function fetchAllHalls(day, meal) {
  const cacheKey = `${day}:${meal}`;
  if (hallsCache.has(cacheKey)) return hallsCache.get(cacheKey);
  const res = await fetch(`https://campusmess.in/api/today?day=${encodeURIComponent(day)}&meal=${encodeURIComponent(meal)}`);
  if (!res.ok) throw new Error(`campusmess.in HTTP ${res.status}`);
  const body = await res.json();
  const halls = body.data || [];
  hallsCache.set(cacheKey, halls);
  return halls;
}

function buildConfirmMessage(name, hallName, meal, desc, wasAutoPicked) {
  if (!desc) return `${name}, ready for ${meal.toLowerCase()}? ${hallName ? `${hallName}'s` : 'the'} menu isn't posted yet.`;
  if (wasAutoPicked) return `${name}, you didn't pick — best guess: ${desc} at ${hallName} for ${meal.toLowerCase()}.`;
  return `${name}, ready for ${desc} at ${hallName} for ${meal.toLowerCase()}?`;
}

function buildTeaserMessage(name, meal, bestHall) {
  if (!bestHall) return `${name}, time to pick your ${meal.toLowerCase()} hall — tap to see today's menus.`;
  const desc = bestHall.currentMenu ? bestHall.currentMenu.description : '';
  return `${name}, ${bestHall.name} has ${desc || 'something good'} — tap to pick your ${meal.toLowerCase()} hall.`;
}

async function getSubscribers() {
  const res = await fetch(`${WORKER_URL}/subscriptions`, {
    headers: { Authorization: `Bearer ${ADMIN_SECRET}` }
  });
  if (!res.ok) throw new Error(`subscriptions fetch failed: HTTP ${res.status}`);
  return res.json();
}

async function getPicks(date) {
  const res = await fetch(`${WORKER_URL}/picks?date=${encodeURIComponent(date)}`, {
    headers: { Authorization: `Bearer ${ADMIN_SECRET}` }
  });
  if (!res.ok) throw new Error(`picks fetch failed: HTTP ${res.status}`);
  const list = await res.json();
  const map = new Map();
  for (const p of list) map.set(`${p.id}:${p.meal}`, p);
  return map;
}

async function sendPush(subscription, title, body, url) {
  try {
    await webpush.sendNotification(subscription, JSON.stringify({ title, body, url }));
  } catch (e) {
    console.error('push failed', e.statusCode, e.body);
  }
}

async function main() {
  const now = istNow();
  const currentHHMM = hhmm(now);
  const today = dayName(now);
  const todayISO = isoDate(now);
  const tomorrowD = new Date(now.getTime() + 24 * 3600 * 1000);
  const tomorrow = dayName(tomorrowD);
  const tomorrowISO = isoDate(tomorrowD);

  const subs = await getSubscribers();
  console.log(`[${currentHHMM} IST] checking ${subs.length} subscriber(s)`);

  const picksToday = await getPicks(todayISO);

  for (const sub of subs) {
    const name = sub.name || 'there';
    const prefs = sub.prefs || {};
    const times = sub.times || {};
    const planTimes = sub.planTimes || {};

    // ---- confirm pushes (today's meals) ----
    for (const meal of ['Breakfast', 'Lunch', 'Dinner']) {
      if (times[meal] !== currentHHMM) continue;
      try {
        const halls = await fetchAllHalls(today, meal);
        const pick = picksToday.get(`${sub.id}:${meal}`);
        let hall = pick ? halls.find(h => h.id === pick.hallId) : null;
        let wasAutoPicked = false;
        if (!hall) {
          hall = bestHallFor(halls, prefs);
          wasAutoPicked = true;
        }
        const desc = hall && hall.currentMenu ? hall.currentMenu.description : null;
        const msg = buildConfirmMessage(name, hall ? hall.name : null, meal, desc, wasAutoPicked);
        await sendPush(sub.subscription, `${meal} time`, msg, './index.html');
        console.log(`sent ${meal} confirm to ${name}${wasAutoPicked ? ' (auto-picked)' : ''}`);
      } catch (e) {
        console.error(`failed to build/send ${meal} confirm:`, e.message);
      }
    }

    // ---- planning pushes ----
    const planningJobs = [];
    if (planTimes.Lunch === currentHHMM) planningJobs.push({ meal: 'Lunch', day: today, date: todayISO });
    if (planTimes.Dinner === currentHHMM) planningJobs.push({ meal: 'Dinner', day: today, date: todayISO });
    if (sub.nightBeforePlan && currentHHMM === '21:00') planningJobs.push({ meal: 'Breakfast', day: tomorrow, date: tomorrowISO });

    for (const job of planningJobs) {
      try {
        const halls = await fetchAllHalls(job.day, job.meal);
        const best = bestHallFor(halls, prefs);
        const msg = buildTeaserMessage(name, job.meal, best);
        const url = `./index.html?pick=${encodeURIComponent(job.meal)}&date=${job.date}`;
        await sendPush(sub.subscription, `Pick your ${job.meal.toLowerCase()}`, msg, url);
        console.log(`sent ${job.meal} planning push to ${name}`);
      } catch (e) {
        console.error(`failed to build/send ${job.meal} planning push:`, e.message);
      }
    }
  }
}

main().catch(e => { console.error(e); process.exit(1); });
