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

// Durable, browsable storage for finished play-call transcripts. Before this existed, the ONLY
// copy of a session's transcript was a single Resend email sent from agent/index.js -- and that
// email has been confirmed broken (the Resend sandbox sender can only deliver to Chris's own
// signup address, not a real coach's inbox), which meant a whole practice's dictation could be
// silently lost with no way to recover it. Now agent/index.js saves the full transcript here
// FIRST, unconditionally, and email is just a best-effort notification on top of that. One JSON
// index + one flat text file per session -- plenty durable for this project's scale. Not
// committed to git (see .gitignore), same treatment as call-log-emails.json.
const transcriptsDir = path.join(dataDir, 'transcripts');
const transcriptFilesDir = path.join(transcriptsDir, 'files');
const transcriptsIndexPath = path.join(transcriptsDir, 'index.json');
fs.mkdirSync(transcriptFilesDir, { recursive: true });

function loadTranscriptIndex() {
  try {
    return JSON.parse(fs.readFileSync(transcriptsIndexPath, 'utf8'));
  } catch {
    return [];
  }
}

let transcriptIndex = loadTranscriptIndex();

function saveTranscriptIndex() {
  fs.writeFileSync(transcriptsIndexPath, JSON.stringify(transcriptIndex, null, 2));
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

// Canonical team code -> human team name. This is the source of truth for which codes are
// real. Before this existed, /api/token accepted ANY string a coach typed and used it directly
// as the LiveKit room name -- a single fat-fingered character (missing the leading zero,
// "onfield-2" instead of "onfield-02") silently created a brand-new, empty room instead of
// failing. That's exactly what happened during the 2026-09-10 field test: a coach and the
// video coordinator each spent several minutes alone in rooms nobody else was in, unable to
// hear anyone, with no error telling them why. Now an unrecognized code is rejected up front.
//
// Team codes are also moving from the old onfield-01/onfield-02/... numbering to short,
// one-word team names -- much harder to mistype than a hyphenated number with a leading zero.
// Old numeric codes are kept working via TEAM_CODE_ALIASES below so nobody who already wrote
// one down on a whiteboard gets locked out.
//
// To onboard a new team: add its code here (and, only if renaming an existing team, an alias
// below pointing old -> new), redeploy this server, then update claude/pilot-teams-roster.md.
const TEAM_CODES = {
  'practice-demo': 'Demo / Testing',
  dexter: 'Dexter Football',
  redhook: 'Red Hook Athletics',
};

// Legacy/alternate code -> the canonical code it should resolve to. Resolving to the SAME
// canonical string is what matters here -- if "onfield-02" and "dexter" resolved to two
// different room names, coaches using different codes for the same team would once again be
// silently split into separate rooms, just one layer further down than the original bug.
const TEAM_CODE_ALIASES = {
  'onfield-01': 'redhook',
  'onfield-02': 'dexter',
};

// Normalizes and resolves a typed team code to its canonical form, or null if it isn't a code
// this server knows about at all. The mobile app already does heavier normalization
// client-side (stripping punctuation etc.) before sending practiceId, but we don't trust that
// blindly here -- this is the actual gate that decides whether a room gets created.
function resolveTeamCode(raw) {
  const normalized = String(raw || '').trim().toLowerCase();
  if (TEAM_CODES[normalized]) return normalized;
  if (TEAM_CODE_ALIASES[normalized]) return TEAM_CODE_ALIASES[normalized];
  return null;
}

app.get('/health', (_req, res) => res.json({ ok: true, service: 'coachcom-token-server' }));

app.post('/api/token', async (req, res) => {
  try {
    const { name, role, side, practiceId = 'practice-demo' } = req.body;
    if (!name || !role || !side) return res.status(400).json({ error: 'name, role and side are required' });

    const resolvedTeamCode = resolveTeamCode(practiceId);
    if (!resolvedTeamCode) {
      return res.status(404).json({
        error: `Team code "${practiceId}" isn't recognized. Double check it with your coach.`,
      });
    }

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
      room: resolvedTeamCode,
      canPublish: true,
      canSubscribe: true,
    });

    res.json({
      token: await token.toJwt(),
      url: process.env.LIVEKIT_URL,
      identity,
      priority,
      practiceId: resolvedTeamCode,
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
    const practiceId = resolveTeamCode(req.query.practiceId) || req.query.practiceId || 'practice-demo';

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

// Saves a finished practice's full play-call transcript, called once by agent/index.js at
// session end (see the comment above transcriptsDir for why this exists). practiceId is
// resolved through the same alias table as everything else so "onfield-02" and "dexter"
// transcripts land together under one team, not split by whichever code happened to be typed.
app.post('/api/transcripts', (req, res) => {
  const { practiceId: rawPracticeId, sessionDate, text } = req.body;
  if (!rawPracticeId || !text) return res.status(400).json({ error: 'practiceId and text are required' });
  const practiceId = resolveTeamCode(rawPracticeId) || rawPracticeId;
  const savedAt = new Date().toISOString();
  const id = `${practiceId}-${savedAt.replace(/[:.]/g, '-')}`;
  const filename = `${id}.txt`;
  fs.writeFileSync(path.join(transcriptFilesDir, filename), text);
  const lineCount = text.split('\n').filter(Boolean).length;
  transcriptIndex.unshift({
    id,
    practiceId,
    teamName: TEAM_CODES[practiceId] || practiceId,
    sessionDate: sessionDate || savedAt.slice(0, 10),
    savedAt,
    filename,
    lineCount,
  });
  saveTranscriptIndex();
  res.json({ ok: true, id });
});

// Lists saved transcripts, optionally filtered to one team -- used by the /transcripts page
// below and available for the mobile app to consume later if it wants an in-app list too.
app.get('/api/transcripts', (req, res) => {
  const { practiceId: rawPracticeId } = req.query;
  const practiceId = rawPracticeId ? (resolveTeamCode(rawPracticeId) || rawPracticeId) : null;
  const list = practiceId ? transcriptIndex.filter(t => t.practiceId === practiceId) : transcriptIndex;
  res.json({ transcripts: list });
});

app.get('/api/transcripts/:id/download', (req, res) => {
  const entry = transcriptIndex.find(t => t.id === req.params.id);
  if (!entry) return res.status(404).json({ error: 'Transcript not found' });
  res.setHeader('Content-Disposition', `attachment; filename="${entry.filename}"`);
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.sendFile(path.join(transcriptFilesDir, entry.filename));
});

// Simple, no-login browsable page listing every saved session with a one-click download --
// this is the "link or page" Chris asked for so coaches can get at the dictation for building
// play sheets without going through Chris's laptop or a flaky email.
app.get('/transcripts', (req, res) => {
  const rows = transcriptIndex.map(t => `
    <tr>
      <td style="padding:8px 12px;border-bottom:1px solid #eee;">${t.teamName}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #eee;">${t.sessionDate}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #eee;">${new Date(t.savedAt).toLocaleString()}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #eee;">${t.lineCount}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #eee;"><a href="/api/transcripts/${t.id}/download">Download</a></td>
    </tr>`).join('');
  res.setHeader('Content-Type', 'text/html');
  res.send(`<!doctype html>
<html><body style="font-family:-apple-system,sans-serif;padding:24px;max-width:900px;margin:0 auto;">
  <h2>OnField Comms — Saved Transcripts</h2>
  ${transcriptIndex.length === 0 ? '<p>No transcripts saved yet -- they show up here automatically once a practice with the head coach or a coordinator talking finishes.</p>' : `
  <table style="width:100%;border-collapse:collapse;">
    <thead><tr style="text-align:left;border-bottom:2px solid #333;">
      <th style="padding:8px 12px;">Team</th><th style="padding:8px 12px;">Date</th><th style="padding:8px 12px;">Saved</th><th style="padding:8px 12px;">Lines</th><th style="padding:8px 12px;">Transcript</th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table>`}
</body></html>`);
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
  const { practiceId: rawPracticeId, email } = req.body;
  if (!rawPracticeId) return res.status(400).json({ error: 'practiceId is required' });
  const practiceId = resolveTeamCode(rawPracticeId) || rawPracticeId;
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
  const { practiceId: rawPracticeId } = req.query;
  if (!rawPracticeId) return res.status(400).json({ error: 'practiceId is required' });
  const practiceId = resolveTeamCode(rawPracticeId) || rawPracticeId;
  res.json({ email: callLogEmails[practiceId] || null });
});

const port = Number(process.env.PORT || 3001);
app.listen(port, '0.0.0.0', () => console.log(`OnField Comms token server listening on :${port}`));
