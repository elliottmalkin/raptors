// netlify/functions/get-signups.mjs
// Returns all signups. editTokens are NEVER sent to the client.

import { getStore } from '@netlify/blobs';

export default async () => {
  try {
    const store = getStore('signups');
    const listed = await store.list();
    const result = {};

    await Promise.all(
      listed.blobs.map(async ({ key }) => {
        const raw = await store.get(key);
        if (raw) {
          try {
            const parsed = JSON.parse(raw);
            const { editToken, ...safe } = parsed;
            result[parsed.gameId] = safe;
          } catch { /* skip malformed */ }
        }
      })
    );

    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    console.error('get-signups error:', err);
    return new Response('Internal server error', { status: 500 });
  }
};
