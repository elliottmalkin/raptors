// netlify/functions/send-reminders.mjs
import { getStore } from '@netlify/blobs';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const moduleDir = path.dirname(fileURLToPath(import.meta.url));

function loadGames() {
  return JSON.parse(fs.readFileSync(path.join(moduleDir, '..', '..', 'games.json'), 'utf8'));
}

function daysUntil(isoDate) {
  const today = new Date(); today.setHours(0,0,0,0);
  return Math.round((new Date(isoDate + 'T00:00:00') - today) / 86_400_000);
}

function friendlyDate(isoDate) {
  return new Date(isoDate + 'T00:00:00Z').toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC',
  });
}

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
  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_FROM_NUMBER) throw new Error('Twilio env vars missing');
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json`, {
    method: 'POST',
    headers: { Authorization: `Basic ${Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString('base64')}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ To: to, From: TWILIO_FROM_NUMBER, Body: body }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`Twilio ${res.status}: ${json.message || JSON.stringify(json)}`);
  return { sid: json.sid, status: json.status, errorCode: json.error_code, errorMessage: json.error_message };
}

async function sendEmail(to, subject, text) {
  const { RESEND_API_KEY, RESEND_FROM_EMAIL } = process.env;
  if (!RESEND_API_KEY || !RESEND_FROM_EMAIL) throw new Error('Resend env vars missing');
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: RESEND_FROM_EMAIL, to, subject, text }),
  });
  if (!res.ok) throw new Error(`Resend ${res.status}: ${await res.text()}`);
}

export default async () => {
  let games;
  try { games = loadGames(); }
  catch (e) { console.error('Could not load games.json:', e.message); return new Response('Could not load games.json', { status: 500 }); }

  const store  = getStore('signups');
  const report = [];

  for (const game of games) {
    if (!game.isoDate || game.isoDate === 'TBD' || game.cancelled || game.test) continue;
    const days = daysUntil(game.isoDate);
    if (days < 1) continue;

    let raw;
    try { raw = await store.get(`game-${game.id}`); } catch { continue; }
    if (!raw) continue;

    let signup;
    try { signup = JSON.parse(raw); } catch { continue; }

    if (String(days) !== String(signup.remindDays)) {
      report.push({ gameId: game.id, opponent: game.opponent, days, skipped: `remindDays=${signup.remindDays} does not match days-until=${days}` });
      continue;
    }

    const prettyDate = friendlyDate(game.isoDate);
    const msg = `Hi ${signup.name}!\n\nReminder: you signed up to bring the post-game snack for:\n\nRaptors vs ${game.opponent} on ${prettyDate}.\n\nGo Raptors! ⚽`;
    const subject = `Snack reminder: Raptors vs ${game.opponent} on ${prettyDate}`;
    const entry = { gameId: game.id, opponent: game.opponent, days, remindHow: signup.remindHow };

    if (signup.remindHow === 'text' || signup.remindHow === 'both') {
      const e164 = toE164(signup.phone);
      if (!signup.phone) entry.text = 'skipped — no phone';
      else if (!e164) entry.text = `skipped — could not normalize "${signup.phone}" to E.164`;
      else {
        try { const tw = await sendText(e164, msg); entry.text = `sent to ${e164} (sid=${tw.sid} status=${tw.status}${tw.errorCode ? ` error=${tw.errorCode}` : ''})`; }
        catch (e) { entry.text = `failed: ${e.message}`; }
      }
    } else { entry.text = 'not requested'; }

    if (signup.remindHow === 'email' || signup.remindHow === 'both') {
      if (!signup.email) entry.email = 'skipped — no email';
      else {
        try { await sendEmail(signup.email, subject, msg); entry.email = `sent to ${signup.email}`; }
        catch (e) { entry.email = `failed: ${e.message}`; }
      }
    } else { entry.email = 'not requested'; }

    report.push(entry);
  }

  console.log('send-reminders report:', JSON.stringify(report, null, 2));
  return new Response(JSON.stringify({ report }, null, 2), { status: 200, headers: { 'Content-Type': 'application/json' } });
};
