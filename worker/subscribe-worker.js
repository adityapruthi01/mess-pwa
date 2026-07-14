// Cloudflare Worker: stores push subscriptions, preferences, and daily
// hall picks in KV. Does NOT send pushes itself — the GitHub Actions script
// does that, using the 'web-push' npm library and the VAPID private key
// (kept as a GH secret, never seen by this Worker).
//
// KV key scheme:
//   sub:<hash(endpoint)>                     -> subscriber record
//   pick:<hash(endpoint)>:<date>:<meal>       -> { hallId, pickedAt }, TTL'd
//
// Routes:
//   POST   /subscribe          (public)  -> store/update a subscriber record
//   DELETE /subscribe          (public)  -> body: { endpoint } remove a subscriber
//   POST   /pick               (public)  -> body: { endpoint, date, meal, hallId }
//   GET    /subscriptions      (admin)   -> requires header Authorization: Bearer <ADMIN_SECRET>
//                                            returns [{ id, subscription, prefs, name, times, planTimes, nightBeforePlan }, ...]
//   GET    /picks?date=YYYY-MM-DD  (admin) -> returns [{ id, meal, hallId }, ...] for that date

const PICK_TTL_SECONDS = 3 * 24 * 60 * 60; // 3 days

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization'
  };
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders() }
  });
}

async function keyFor(endpoint) {
  const enc = new TextEncoder().encode(endpoint);
  const hash = await crypto.subtle.digest('SHA-256', enc);
  return [...new Uint8Array(hash)].map(b => b.toString(16).padStart(2, '0')).join('');
}

function requireAdmin(request, env) {
  const auth = request.headers.get('Authorization') || '';
  return auth === `Bearer ${env.ADMIN_SECRET}`;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders() });
    }

    if (url.pathname === '/subscribe' && request.method === 'POST') {
      const body = await request.json();
      if (!body.subscription || !body.subscription.endpoint) {
        return json({ error: 'missing subscription' }, 400);
      }
      const hash = await keyFor(body.subscription.endpoint);
      await env.MESS_SUBS.put(`sub:${hash}`, JSON.stringify({
        subscription: body.subscription,
        prefs: body.prefs || { liked: [], disliked: [] },
        name: body.name || 'there',
        times: body.times || {},
        planTimes: body.planTimes || {},
        nightBeforePlan: !!body.nightBeforePlan
      }));
      return json({ ok: true, id: hash });
    }

    if (url.pathname === '/subscribe' && request.method === 'DELETE') {
      const body = await request.json();
      if (!body.endpoint) return json({ error: 'missing endpoint' }, 400);
      const hash = await keyFor(body.endpoint);
      await env.MESS_SUBS.delete(`sub:${hash}`);
      return json({ ok: true });
    }

    if (url.pathname === '/pick' && request.method === 'POST') {
      const body = await request.json();
      if (!body.endpoint || !body.date || !body.meal || !body.hallId) {
        return json({ error: 'missing endpoint, date, meal, or hallId' }, 400);
      }
      const hash = await keyFor(body.endpoint);
      await env.MESS_SUBS.put(
        `pick:${hash}:${body.date}:${body.meal}`,
        JSON.stringify({ hallId: body.hallId, pickedAt: Date.now() }),
        { expirationTtl: PICK_TTL_SECONDS }
      );
      return json({ ok: true });
    }

    if (url.pathname === '/subscriptions' && request.method === 'GET') {
      if (!requireAdmin(request, env)) return json({ error: 'unauthorized' }, 401);
      const list = await env.MESS_SUBS.list({ prefix: 'sub:' });
      const records = [];
      for (const key of list.keys) {
        const val = await env.MESS_SUBS.get(key.name);
        if (val) records.push({ id: key.name.slice('sub:'.length), ...JSON.parse(val) });
      }
      return json(records);
    }

    if (url.pathname === '/picks' && request.method === 'GET') {
      if (!requireAdmin(request, env)) return json({ error: 'unauthorized' }, 401);
      const date = url.searchParams.get('date');
      if (!date) return json({ error: 'missing date query param' }, 400);
      const list = await env.MESS_SUBS.list({ prefix: 'pick:' });
      const records = [];
      for (const key of list.keys) {
        // pick:<hash>:<date>:<meal>
        const parts = key.name.split(':');
        const [, hash, keyDate, meal] = parts;
        if (keyDate !== date) continue;
        const val = await env.MESS_SUBS.get(key.name);
        if (val) records.push({ id: hash, meal, ...JSON.parse(val) });
      }
      return json(records);
    }

    return json({ error: 'not found' }, 404);
  }
};
