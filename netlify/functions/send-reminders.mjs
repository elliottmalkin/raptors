// netlify/functions/send-reminders.mjs
// Runs every morning at 9 AM Eastern (set in netlify.toml).
// Reads the game schedule from games.json so it stays in sync automatically.
//
// Required environment variables (Netlify dashboard → Site → Environment variables):
//   TWILIO_ACCOUNT_SID   — from console.twilio.com
//   TWILIO_AUTH_TOKEN    — from console.twilio.com
//   TWILIO_FROM_NUMBER   — your Twilio number, e.g. +18455550100
//   RESEND_API_KEY       — from resend.com
//   RESEND_FROM_EMAIL    — verified sender, e.g. reminders@yourdomain.com

import { getStore } from '@netlify/blobs';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const moduleDir = path.dirname(fileURLToPath(import.meta.url));

// ── Load games from the single source of truth ────────────────────────────────
function loadGames() {
  // moduleDir is netlify/functions/ — go up two levels to repo root
  const gamesPath = path.join(moduleDir, '..', '..', 'games.json');
  return JSON.parse(fs.readFileSync(gamesPath, 'utf8'));
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function daysUntil(isoDate) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const game  = new Date(isoDate + 'T00:00:00');
  return Math.round((game - today) / 86_400_000);
}

// "2026-04-12" → "Sunday, April 12"
function friendlyDate(isoDate) {
  return new Date(isoDate + 'T00:00:00Z').toLocaleDateString('en-US', {
    weekday:  'long',
    month:    'long',
    day:      'numeric',
    timeZone: 'UTC',
  });
}

// Normalize US phone numbers to E.164 (+1XXXXXXXXXX). Leaves already-E.164
// numbers alone. Returns null if we can't confidently parse it.
function toE164(raw) {
  if (!raw) return null;
  const digits = String(raw).replace(/\D/g, '');
  if (String(raw).trim().startsWith('+')) return '+' + digits;
  if (digits.length === 10) return '+1' + digits;
  if (digits.length === 11 && digits.startsWith('1')) return '+' + digits;
  return null;
}

async function sendText(to, body) {
  const { TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER } = process.env;
  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_FROM_NUMBER) {
    throw new Error('Twilio env vars missing (TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN/TWILIO_FROM_NUMBER)');
  }
  const url  = `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json`;
  const auth = Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString('base64');
  const res  = await fetch(url, {
    method:  'POST',
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    new URLSearchParams({ To: to, From: TWILIO_FROM_NUMBER, Body: body }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`Twilio ${res.status}: ${json.message || JSON.stringify(json)}`);
  // Return sid + status so callers can surface delivery details
  return { sid: json.sid, status: json.status, errorCode: json.error_code, errorMessage: json.error_message };
}

async function sendEmail(to, subject, text) {
  const { RESEND_API_KEY, RESEND_FROM_EMAIL } = process.env;
  if (!RESEND_API_KEY || !RESEND_FROM_EMAIL) {
    throw new Error('Resend env vars missing (RESEND_API_KEY/RESEND_FROM_EMAIL)');
  }
  const res = await fetch('https://api.resend.com/emails', {
    method:  'POST',
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body:    JSON.stringify({ from: RESEND_FROM_EMAIL, to, subject, text }),
  });
  if (!res.ok) throw new Error(`Resend ${res.status}: ${await res.text()}`);
}

// ── Handler ───────────────────────────────────────────────────────────────────
export default async () => {
  let games;
  try {
    games = loadGames();
  } catch (e) {
    console.error('Could not load games.json:', e.message);
    return new Response('Could not load games.json', { status: 500 });
  }

  const store  = getStore('signups');
  const report = [];

  console.log('send-reminders: processing', games.length, 'games, today UTC =', new Date().toISOString());

  for (const game of games) {
    if (!game.isoDate || game.isoDate === 'TBD') continue;

    const days = daysUntil(game.isoDate);
    if (days < 1) continue;

    // Only log upcoming games (days >= 1) to keep daily logs concise
    console.log(`game-${game.id} (${game.opponent}): isoDate=${game.isoDate} days=${days}`);

    let raw;
    try {
      raw = await store.get(`game-${game.id}`);
    } catch (blobsErr) {
      console.error(`Blobs error reading game-${game.id}:`, blobsErr.message || blobsErr);
      continue;
    }
    if (!raw) {
      console.log(`No signup found in Blobs for game-${game.id}`);
      continue;
    }
    console.log(`Found signup for game-${game.id}:`, raw.slice(0, 200));

    let signup;
    try { signup = JSON.parse(raw); } catch (parseErr) {
      console.error(`JSON parse error for game-${game.id}:`, parseErr.message);
      continue;
    }

    if (String(days) !== String(signup.remindDays)) {
      report.push({
        gameId: game.id, opponent: game.opponent, days,
        skipped: `remindDays=${signup.remindDays} does not match days-until=${days}`,
      });
      continue;
    }

    const prettyDate = friendlyDate(game.isoDate);
    const msg =
      `Raptors Snacks\n\n` +
      `Hi ${signup.name}!\n\n` +
      `Reminder: you signed up to bring the post-game snack for:\n\n` +
      `Raptors vs ${game.opponent} on ${prettyDate}.\n\n` +
      `Go Raptors! ⚽`;
    const subject = `Snack reminder: Raptors vs ${game.opponent} on ${prettyDate}`;
    const entry = { gameId: game.id, opponent: game.opponent, days, remindHow: signup.remindHow };

    // Text
    if (signup.remindHow === 'text' || signup.remindHow === 'both') {
      const e164 = toE164(signup.phone);
      if (!signup.phone) {
        entry.text = 'skipped — no phone on signup';
      } else if (!e164) {
        entry.text = `skipped — could not normalize phone "${signup.phone}" to E.164`;
      } else {
        try {
          const tw = await sendText(e164, msg);
          entry.text = `sent to ${e164} (sid=${tw.sid} status=${tw.status}${tw.errorCode ? ` error=${tw.errorCode}: ${tw.errorMessage}` : ''})`;
        } catch (e) {
          entry.text = `failed: ${e.message}`;
        }
      }
    } else {
      entry.text = 'not requested';
    }

    // Email
    if (signup.remindHow === 'email' || signup.remindHow === 'both') {
      if (!signup.email) {
        entry.email = 'skipped — no email on signup';
      } else {
        try {
          await sendEmail(signup.email, subject, msg);
          entry.email = `sent to ${signup.email}`;
        } catch (e) {
          entry.email = `failed: ${e.message}`;
        }
      }
    } else {
      entry.email = 'not requested';
    }

    report.push(entry);
  }

  console.log('send-reminders report:', JSON.stringify(report, null, 2));
  return new Response(JSON.stringify({ report }, null, 2), {
    status:  200,
    headers: { 'Content-Type': 'application/json' },
  });
};
