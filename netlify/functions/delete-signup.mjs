// netlify/functions/delete-signup.mjs
import { getStore } from '@netlify/blobs';

function getAdminEmailFromJwt(authHeader) {
  if (!authHeader || !authHeader.startsWith('Bearer ')) return null;
  try {
    const token   = authHeader.slice(7);
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
    return payload.email || null;
  } catch { return null; }
}

export default async (req) => {
  if (req.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });

  let payload;
  try { payload = await req.json(); }
  catch { return new Response('Invalid JSON', { status: 400 }); }

  const { gameId, editToken, adminEdit } = payload;
  if (gameId === undefined || gameId === null) return new Response('gameId is required', { status: 400 });

  const store = getStore('signups');
  const key   = `game-${gameId}`;

  try {
    if (adminEdit) {
      const adminEmail = getAdminEmailFromJwt(req.headers.get('authorization'));
      if (!adminEmail) return new Response('Admin authentication required', { status: 403 });
      await store.delete(key);
      return new Response('{}', { status: 200 });
    }

    const existing = await store.get(key).then(r => r ? JSON.parse(r) : null).catch(() => null);
    if (!existing) return new Response('Signup not found', { status: 404 });
    if (!editToken || editToken !== existing.editToken) return new Response('Invalid edit token', { status: 403 });

    await store.delete(key);
    return new Response('{}', { status: 200 });
  } catch (err) {
    console.error('delete-signup error:', err);
    return new Response('Internal server error', { status: 500 });
  }
};
