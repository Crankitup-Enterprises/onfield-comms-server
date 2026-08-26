import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { AccessToken } from 'livekit-server-sdk';

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));

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
      canUpdateOwnMetadata: true,
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
    token.addGrant({ roomJoin: true, room: practiceId, canPublish: true, canSubscribe: true, canUpdateOwnMetadata: true });
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

const port = Number(process.env.PORT || 3001);
app.listen(port, '0.0.0.0', () => console.log(`OnField Comms token server listening on :${port}`));
