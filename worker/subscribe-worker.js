// Cloudflare Worker: stores push subscriptions + preferences in KV.
// Does NOT send pushes itself — the GitHub Actions script does that,
// using the 'web-push' npm library and the VAPID private key (kept as a GH secret, never seen by this Worker).
//
// Routes:
//   POST /subscribe      (public)  -> store/update a subscriber record
//   DELETE /subscribe    (public)  -> body: { endpoint } remove a subscriber
//   GET  /subscriptions  (admin)   -> requires header  Authorization: Bearer <ADMIN_SECRET>
//                                     returns [{ id, subscription, hallId, prefs, times, nightBefore, name }, ...]

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
      const id = await keyFor(body.subscription.endpoint);
      await env.MESS_SUBS.put(id, JSON.stringify(body));
      return json({ ok: true, id });
    }

    if (url.pathname === '/subscribe' && request.method === 'DELETE') {
      const body = await request.json();
      if (!body.endpoint) return json({ error: 'missing endpoint' }, 400);
      const id = await keyFor(body.endpoint);
      await env.MESS_SUBS.delete(id);
      return json({ ok: true });
    }

    if (url.pathname === '/subscriptions' && request.method === 'GET') {
      const auth = request.headers.get('Authorization') || '';
      if (auth !== `Bearer ${env.ADMIN_SECRET}`) {
        return json({ error: 'unauthorized' }, 401);
      }
      const list = await env.MESS_SUBS.list();
      const records = [];
      for (const key of list.keys) {
        const val = await env.MESS_SUBS.get(key.name);
        if (val) records.push({ id: key.name, ...JSON.parse(val) });
      }
      return json(records);
    }

    return json({ error: 'not found' }, 404);
  }
};
