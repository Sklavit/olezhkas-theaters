import { getStore } from '@netlify/blobs';

/*
 * The shared half of the theatre's memory.
 *
 *   GET  /api/storage?key=theater:shows  ->  { "value": "<json string>" | null }
 *   PUT  /api/storage?key=theater:shows  <-  the JSON to store
 *
 * The browser keeps the per-person things (theme, who is signed in) in
 * localStorage and never asks us about them.
 */

// Only these three. Without the allowlist the endpoint is a free key-value
// store for anyone who finds the URL.
const KEYS = new Set(['theater:shows', 'theater:messages', 'theater:settings']);

const MAX_BYTES = 512 * 1024;

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-store'
    }
  });

export default async (req) => {
  const key = new URL(req.url).searchParams.get('key');
  if (!key || !KEYS.has(key)) return json({ error: 'unknown key' }, 400);

  // Strong consistency: two people on two phones should not see two
  // different calendars because one of them read a stale replica.
  const store = getStore({ name: 'theater', consistency: 'strong' });

  try {
    if (req.method === 'GET') {
      const value = await store.get(key);
      return json({ value: value ?? null });
    }

    if (req.method === 'PUT') {
      const body = await req.text();
      if (body.length > MAX_BYTES) return json({ error: 'too big' }, 413);
      try {
        JSON.parse(body);
      } catch {
        return json({ error: 'not json' }, 400);
      }
      await store.set(key, body);
      return json({ ok: true });
    }

    return json({ error: 'method not allowed' }, 405);
  } catch (e) {
    console.error('storage failed', { key, method: req.method, message: e.message });
    return json({ error: 'storage failed' }, 502);
  }
};

export const config = { path: '/api/storage' };
