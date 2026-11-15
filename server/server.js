import express from 'express';
import cors from 'cors';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import * as mongo from './lib/mongo.js';
import * as tiger from './lib/tiger.js';
import * as solana from './lib/solana.js';
import * as gemini from './lib/gemini.js';

const __dir = dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(cors());
app.use(express.json({ limit: '60mb' }));

const HEX = /^[0-9a-fA-F]*$/;
const isHex = (s, len) => typeof s === 'string' && HEX.test(s) && (len ? s.length === len : s.length > 0);
const KINDS = new Set(['capture', 'burn', 'verify', 'fail']);
const wrap = (fn) => (req, res) => fn(req, res).catch((e) => { console.error(e); res.status(500).json({ error: String(e.message || e) }); });

app.get('/api/health', (_req, res) => res.json({
  ok: true,
  integrations: { mongo: mongo.enabled(), tiger: tiger.enabled(), solana: solana.enabled(), gemini: gemini.enabled() },
}));

app.post('/api/clips', wrap(async (req, res) => {
  const b = req.body || {};
  if (!isHex(b.uid) || !isHex(b.seed, 64) || !isHex(b.digest, 64))
    return res.status(400).json({ error: 'uid (hex), seed (64 hex), digest (64 hex) required' });
  const clip = {
    id: randomUUID(),
    label: String(b.label ?? '').slice(0, 200),
    uid: b.uid.toLowerCase(), seed: b.seed.toLowerCase(), digest: b.digest.toLowerCase(),
    w: b.w | 0, h: b.h | 0, n: b.n | 0,
    timeline: Array.isArray(b.timeline) ? b.timeline.slice(0, 200).map(String) : [],
    source: b.source === 'mobile' ? 'mobile' : 'web',
    createdAt: new Date(),
  };
  clip.anchor = await solana.anchor(clip.uid, clip.digest);
  await mongo.insertClip(clip);
  await tiger.insertEvent({ kind: 'capture', uid: clip.uid, ms: null, result: null, detail: `clip ${clip.id} ${clip.label}` });
  res.json({ id: clip.id, anchor: clip.anchor });
}));

app.get('/api/clips', wrap(async (_req, res) => res.json(await mongo.latestClips(50))));

app.post('/api/events', wrap(async (req, res) => {
  const b = req.body || {};
  if (!KINDS.has(b.kind)) return res.status(400).json({ error: 'kind must be capture|burn|verify|fail' });
  const ev = {
    kind: b.kind,
    uid: b.uid == null ? null : String(b.uid).slice(0, 64),
    ms: Number.isFinite(+b.ms) && b.ms !== null ? Math.round(+b.ms) : null,
    result: b.result === 'pass' || b.result === 'fail' ? b.result : null,
    detail: b.detail == null ? null : String(typeof b.detail === 'string' ? b.detail : JSON.stringify(b.detail)).slice(0, 2000),
  };
  await tiger.insertEvent(ev);
  res.json({ ok: true, stored: tiger.enabled() ? 'tiger' : 'memory' });
}));

app.get('/api/events/stats', wrap(async (_req, res) => res.json(await tiger.stats())));

app.post('/api/twin', wrap(async (req, res) => {
  if (!gemini.enabled()) return res.status(503).json({ error: 'GEMINI_API_KEY not set' });
  const { frames } = req.body || {};
  if (!Array.isArray(frames) || !frames.length) return res.status(400).json({ error: 'frames[] required' });
  res.json(await gemini.twin(frames));
}));

app.post('/api/explain', wrap(async (req, res) => res.json({ text: await gemini.explain(req.body || {}) })));


const PORT = +process.env.PORT || 8787;
await Promise.all([mongo.init(), tiger.init()]);
app.listen(PORT, () => console.log(`[vericam] listening on :${PORT}`, {
  mongo: mongo.enabled(), tiger: tiger.enabled(), solana: solana.enabled(), gemini: gemini.enabled(),
}));
