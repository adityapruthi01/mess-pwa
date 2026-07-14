// Runs on a schedule via GitHub Actions (every 5 minutes).
// For each stored subscriber: if the current IST time matches one of their
// reminder times, fetch that meal's menu from campusmess.in, check it
// against their preferences, and push a notification.

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

async function fetchMenu(day, meal, hallId) {
  const res = await fetch(`https://campusmess.in/api/today?day=${encodeURIComponent(day)}&meal=${encodeURIComponent(meal)}`);
  if (!res.ok) throw new Error(`campusmess.in HTTP ${res.status}`);
  const body = await res.json();
  const hall = (body.data || []).find(h => h.id === hallId);
  return hall ? hall.currentMenu : null;
}

function buildMessage(name, hallName, meal, menu, verdict) {
  const desc = menu ? menu.description : 'no menu posted yet';
  if (verdict.tag === 'go') {
    return `${name}, ${desc} at ${hallName} for ${meal.toLowerCase()} — sounds like your kind of meal!`;
  }
  if (verdict.tag === 'skip') {
    return `${name}, ${meal} at ${hallName} today is ${desc} — might not be your thing.`;
  }
  return `${name}, ready for ${meal.toLowerCase()} at ${hallName}? Today: ${desc}`;
}

async function getSubscribers() {
  const res = await fetch(`${WORKER_URL}/subscriptions`, {
    headers: { Authorization: `Bearer ${ADMIN_SECRET}` }
  });
  if (!res.ok) throw new Error(`subscriptions fetch failed: HTTP ${res.status}`);
  return res.json();
}

async function sendPush(subscription, title, body) {
  try {
    await webpush.sendNotification(subscription, JSON.stringify({ title, body }));
  } catch (e) {
    console.error('push failed', e.statusCode, e.body);
  }
}

async function main() {
  const now = istNow();
  const currentHHMM = hhmm(now);
  const today = dayName(now);
  const tomorrow = dayName(new Date(now.getTime() + 24 * 3600 * 1000));

  const subs = await getSubscribers();
  console.log(`[${currentHHMM} IST] checking ${subs.length} subscriber(s)`);

  for (const sub of subs) {
    const name = sub.name || 'there';
    const hallId = sub.hallId;
    const times = sub.times || {};
    const meals = ['Breakfast', 'Lunch', 'Dinner'];

    for (const meal of meals) {
      if (times[meal] === currentHHMM) {
        try {
          const menu = await fetchMenu(today, meal, hallId);
          const verdict = verdictFor(menu ? menu.description : '', sub.prefs || {});
          const hallName = menu ? undefined : null;
          const msg = buildMessage(name, `Hall ${hallId}`, meal, menu, verdict);
          await sendPush(sub.subscription, `${meal} check`, msg);
          console.log(`sent ${meal} reminder to ${name}`);
        } catch (e) {
          console.error(`failed to build/send ${meal} reminder:`, e.message);
        }
      }
    }

    // Night-before heads-up, fixed at 21:00 IST
    if (sub.nightBefore && currentHHMM === '21:00') {
      try {
        const lunch = await fetchMenu(tomorrow, 'Lunch', hallId);
        const dinner = await fetchMenu(tomorrow, 'Dinner', hallId);
        const parts = [];
        if (lunch) parts.push(`Lunch: ${lunch.description}`);
        if (dinner) parts.push(`Dinner: ${dinner.description}`);
        await sendPush(sub.subscription, `Tomorrow's menu`, `${name}, tomorrow — ${parts.join(' · ') || 'menu not posted yet'}`);
        console.log(`sent night-before preview to ${name}`);
      } catch (e) {
        console.error('failed to send night-before preview:', e.message);
      }
    }
  }
}

main().catch(e => { console.error(e); process.exit(1); });
