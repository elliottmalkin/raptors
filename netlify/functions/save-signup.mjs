// netlify/functions/save-signup.mjs
import { getStore } from '@netlify/blobs';
import { randomBytes } from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const moduleDir = path.dirname(fileURLToPath(import.meta.url));

function loadGames() {
  return JSON.parse(fs.readFileSync(path.join(moduleDir, '..', '..', 'games.json'), 'utf8'));
}

function isValidEmail(s) {
  return typeof s === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}

function friendlyDate(isoDate) {
  if (!isoDate) return '';
  return new Date(isoDate + 'T00:00:00Z').toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC',
  });
}

function getAdminEmailFromJwt(authHeader) {
  if (!authHeader || !authHeader.startsWith('Bearer ')) return null;
  try {
    const payload = JSON.parse(Buffer.from(authHeader.slice(7).split('.')[1], 'base64url').toString('utf8'));
    return payload.email || null;
  } catch { return null; }
}

async function sendConfirmationEmail(to, name, game, editLink) {
  const { RESEND_API_KEY, RESEND_FROM_EMAIL } = process.env;
  if (!RESEND_API_KEY || !RESEND_FROM_EMAIL) { console.warn('RESEND env vars not set'); return; }
  const locationLine = !game.home && game.location ? `\nLocation: ${game.location}` : '';
  const text =
    `Hi ${name}!\n\n` +
    `Thanks for signing up to bring the post-game snack for Raptors vs ${game.opponent} on ${game.date} at ${game.time}.${locationLine}\n\n` +
    `If you need to change or cancel your signup, use this private link:\n${editLink}\n\n` +
    `Save this link — it's the only way to manage your signup without contacting the team admin.\n\n` +
    `Go Raptors! ⚽`;
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: RESEND_FROM_EMAIL, to, subject: `Snack signup confirmed: Raptors vs ${game.opponent}`, text }),
  });
  if (!res.ok) throw new Error(`Resend: ${await res.text()}`);
}

async function sendAdminNotification(game, signup) {
  const { RESEND_API_KEY, RESEND_FROM_EMAIL, ADMIN_NOTIFY_EMAIL } = process.env;
  if (!RESEND_API_KEY || !RESEND_FROM_EMAIL || !ADMIN_NOTIFY_EMAIL) { console.warn('Admin notify env vars not set'); return; }
  const location = game.home ? 'Starr Park (home)' : (game.location || 'TBD');
  const text =
    `${signup.name} just signed up to bring the post-game snack.\n\n` +
    `Game: Raptors vs ${game.opponent}\n` +
    `Date: ${friendlyDate(game.isoDate)} at ${game.time}\n` +
    `Location: ${location}\n\n` +
    `Contact:\n  Name:  ${signup.name}\n  Email: ${signup.email}\n` +
    (signup.phone ? `  Phone: ${signup.phone}\n` : '') +
    `\nReminder preferences:\n  When: ${signup.remindDays === 'none' ? 'none' : `${signup.remindDays} day(s) before`}\n  How:  ${signup.remindHow || 'none'}\n`;
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: RESEND_FROM_EMAIL, to: ADMIN_NOTIFY_EMAIL, subject: `New snack signup: ${signup.name} for Raptors vs ${game.opponent}`, text }),
  });
  if (!res.ok) throw new Error(`Resend: ${await res.text()}`);
}

export default async (req) => {
  if (req.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });

  let payload;
  try { payload = await req.json(); }
  catch { return new Response('Invalid JSON', { status: 400 }); }

  const { gameId, name, phone, email, remindDays, remindHow, editToken, adminEdit } = payload;
  if (gameId === undefined || gameId === null || !name) return new Response('gameId and name are required', { status: 400 });

  const store = getStore('signups');
  const key   = `game-${gameId}`;

  try {
    const existing = await store.get(key).then(r => r ? JSON.parse(r) : null).catch(() => null);

    if (!existing) {
      if (!isValidEmail(email)) return new Response('A valid email address is required', { status: 400 });
      const newToken = randomBytes(32).toString('hex');
      await store.set(key, JSON.stringify({ gameId, name, phone, email, remindDays, remindHow, editToken: newToken }));
      try {
        const games = loadGames();
        const game  = games.find(g => g.id === gameId);
        if (game) {
          const host = req.headers.get('host') || 'raptors.elliottmalkin.com';
          await Promise.allSettled([
            sendConfirmationEmail(email, name, game, `https://${host}/?game=${gameId}&edit=${newToken}`),
            sendAdminNotification(game, { gameId, name, phone, email, remindDays, remindHow }),
          ]).then(results => results.forEach((r, i) => {
            if (r.status === 'rejected') console.error(`${i === 0 ? 'Confirmation' : 'Admin'} email failed:`, r.reason?.message || r.reason);
          }));
        }
      } catch (e) { console.error('Post-signup email error:', e.message); }
      return new Response(JSON.stringify({ editToken: newToken }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }

    if (adminEdit) {
      if (!getAdminEmailFromJwt(req.headers.get('authorization'))) return new Response('Admin authentication required', { status: 403 });
      await store.set(key, JSON.stringify({ ...existing, name, phone, email }));
      return new Response('{}', { status: 200 });
    }

    if (!editToken || editToken !== existing.editToken) return new Response('Invalid edit token', { status: 403 });
    await store.set(key, JSON.stringify({ ...existing, name, phone, email }));
    return new Response('{}', { status: 200 });

  } catch (err) {
    console.error('save-signup error:', err);
    return new Response('Internal server error', { status: 500 });
  }
};
