import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AccessToken } from 'livekit-server-sdk';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));

// Per-team-code destination for the call-log transcript email, set by a coach from the app
// (App.tsx's CALL LOG screen) instead of Chris typing --email/HOST_EMAIL into agent/index.js
// on his laptop before every practice. One JSON file, not a real database -- this whole
// project is prototype-scale (a handful of pilot teams), and a flat file keyed by team code is
// plenty durable for that, restarts included. Not committed to git (see .gitignore) since it's
// runtime data entered by coaches, not source -- same treatment as agent/logs/.
const dataDir = path.join(__dirname, 'data');
const callLogEmailsPath = path.join(dataDir, 'call-log-emails.json');
fs.mkdirSync(dataDir, { recursive: true });

function loadCallLogEmails() {
  try {
    return JSON.parse(fs.readFileSync(callLogEmailsPath, 'utf8'));
  } catch {
    return {}; // First run (file doesn't exist yet) or corrupt file -- start fresh either way.
  }
}

let callLogEmails = loadCallLogEmails();

function saveCallLogEmails() {
  fs.writeFileSync(callLogEmailsPath, JSON.stringify(callLogEmails, null, 2));
}

const priorities = {
  head_coach: 100,
  offensive_coordinator: 80,
  defensive_coordinator: 80,
  offensive_line: 40,
  running_backs: 40,
  wide_receivers: 40,
  quarterbacks: 40,
  tight_ends: 40,
  offensive_assistant: 40,
  defensive_line: 40,
  inside_linebackers: 40,
  outside_linebackers: 40,
  secondary: 40,
  defensive_assistant: 40,
  // Video crew, added for the video-coordinator/video-assistant channel. Coordinator sits at
  // coordinator tier, assistants at assistant tier -- these values must stay in sync with
  // ROLE_OPTIONS in mobile/src/roles.ts, which is what re-sends priority on a head-coach side
  // switch. An unrecognized role falls back to priority 10 below, so leaving a role out of this
  // map isn't a hard failure, just an under-priority participant.
  video_coordinator: 80,
  video_assistant: 40,
};

app.get('/health', (_req, res) => res.json({ ok: true, service: 'coachcom-token-server' }));

app.post('/api/token', async (req, res) => {
  try {
    const { name, role, side, practiceId = 'practice-demo' } = req.body;
    if (!name || !role || !side) return res.status(400).json({ error: 'name, role and side are required' });

    const priority = priorities[role] ?? 10;
    const identity = `${role}:${name}:${Date.now()}`;
    const metadata = JSON.stringify({ name, role, side, priority });

    const token = new AccessToken(process.env.LIVEKIT_API_KEY, process.env.LIVEKIT_API_SECRET, {
      identity,
      name,
      metadata,
      ttl: '8h',
    });

    token.addGrant({
      roomJoin: true,
      room: practiceId,
      canPublish: true,
      canSubscribe: true,
    });

    res.json({
      token: await token.toJwt(),
      url: process.env.LIVEKIT_URL,
      identity,
      priority,
      practiceId,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Could not create LiveKit token' });
  }
});

// Test-only helper: generates a token for a second "coach" so you can join the same
// room from a browser (meet.livekit.io) and test two-way audio with only one physical
// phone. Not used by the mobile app itself — safe to leave in for now, remove before
// any real distribution.
app.get('/api/test-token', async (req, res) => {
  try {
    const name = req.query.name || 'Test Coach 2';
    const role = req.query.role || 'head_coach';
    const side = req.query.side || 'all';
    const practiceId = req.query.practiceId || 'practice-demo';

    const priority = priorities[role] ?? 10;
    const identity = `${role}:${name}:${Date.now()}`;
    const metadata = JSON.stringify({ name, role, side, priority });

    const token = new AccessToken(process.env.LIVEKIT_API_KEY, process.env.LIVEKIT_API_SECRET, {
      identity,
      name,
      metadata,
      ttl: '8h',
    });
    token.addGrant({ roomJoin: true, room: practiceId, canPublish: true, canSubscribe: true });
    const jwt = await token.toJwt();

    res.setHeader('Content-Type', 'text/html');
    res.send(`<!doctype html>
<html><body style="font-family:-apple-system,sans-serif;padding:24px;max-width:700px;margin:0 auto;">
  <h2>OnField Comms test token</h2>
  <p>Open <a href="https://meet.livekit.io" target="_blank" rel="noopener">meet.livekit.io</a>, choose <b>Custom</b>, and paste these two values in:</p>
  <p><b>Server URL</b><br><input style="width:100%;font-family:monospace;font-size:14px;padding:6px" value="${process.env.LIVEKIT_URL}" onclick="this.select()" readonly></p>
  <p><b>Token</b><br><textarea style="width:100%;height:160px;font-family:monospace;font-size:12px;padding:6px" onclick="this.select()" readonly>${jwt}</textarea></p>
  <p style="color:#555">Room: <code>${practiceId}</code> &middot; Identity: <code>${identity}</code> &middot; Role: <code>${role}</code> &middot; Priority: ${priority}</p>
  <p style="color:#555">Reload this page for a fresh token (valid 8h). Add <code>?role=offensive_line</code> etc. to test a different priority level.</p>
</body></html>`);
  } catch (error) {
    console.error(error);
    res.status(500).send('Could not create test token');
  }
});

// Placeholder for the next increment. Mobile/server can post timestamped transcript chunks here.
app.post('/api/transcript', (req, res) => {
  const { practiceId, speaker, role, text, timestamp = new Date().toISOString() } = req.body;
  console.log('[TRANSCRIPT]', { practiceId, speaker, role, text, timestamp });
  res.json({ ok: true });
});

// Very loose on purpose -- this only guards against obviously-broken input (a typo with no @,
// a pasted phone number). Actually confirming the address is correct is Resend's problem, not
// this server's -- rejecting too aggressively would just be a coach unable to save a real
// address this hasn't seen the shape of before.
const EMAIL_LIKE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Lets a coach set (or clear) which email address this team's call-log transcript gets sent to
// when Chris's call logger (agent/index.js) finishes a practice -- see GET below. Keyed by team
// code so it's set once per team, by whichever coach gets to it first, not per-practice or
// per-phone: that's what makes this "not something Chris has to configure for each room."
app.post('/api/call-log-email', (req, res) => {
  const { practiceId, email } = req.body;
  if (!practiceId) return res.status(400).json({ error: 'practiceId is required' });
  const trimmed = (email || '').trim();
  if (trimmed && !EMAIL_LIKE.test(trimmed)) {
    return res.status(400).json({ error: 'That doesn\'t look like a valid email address' });
  }
  if (trimmed) {
    callLogEmails[practiceId] = trimmed;
  } else {
    delete callLogEmails[practiceId]; // Empty save = coach clearing it, not an error.
  }
  saveCallLogEmails();
  res.json({ ok: true, email: trimmed || null });
});

// agent/index.js calls this once it knows which room it's logging, so Chris never has to pass
// --email or set HOST_EMAIL per team -- whatever a coach last saved for this practiceId from
// the app is what the finished transcript goes to. Also used by the app itself to show the
// currently-saved address on the CALL LOG screen.
app.get('/api/call-log-email', (req, res) => {
  const { practiceId } = req.query;
  if (!practiceId) return res.status(400).json({ error: 'practiceId is required' });
  res.json({ email: callLogEmails[practiceId] || null });
});

const port = Number(process.env.PORT || 3001);
app.listen(port, '0.0.0.0', () => console.log(`OnField Comms token server listening on :${port}`));
