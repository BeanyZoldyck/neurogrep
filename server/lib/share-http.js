import * as tiger from './tiger.js';

export function presentedKey(req) {
  const header = req.get('authorization') || '';
  const match = /^Bearer\s+(\S+)/i.exec(header);
  if (match) return match[1].slice(0, 256);
  const alt = req.get('x-vericam-upload-key');
  return typeof alt === 'string' ? alt.trim().slice(0, 256) : '';
}

function sendErr(res, e) {
  const status = Number.isInteger(e.status) ? e.status : 500;
  if (status >= 500) console.error('[share]', e.message || e);
  res.status(status).json({ error: e.message || 'error' });
}

function need(ctx, res) {
  if (!ctx.share) {
    res.status(503).json({ error: 'share service is not initialized' });
    return null;
  }
  return ctx.share;
}

function one(value) {
  const picked = Array.isArray(value) ? value[0] : value;
  return typeof picked === 'string' ? picked.trim() : '';
}

async function audit(ev) {
  try { await tiger.insertEvent(ev); }
  catch (e) { console.error('[share] event log failed:', e.message); }
}

export function mountShareRoutes(app, ctx) {
  app.post('/api/share/videos', async (req, res) => {
    const share = need(ctx, res);
    if (!share) return;
    try {
      const out = await share.publish({ body: req.body, auth: presentedKey(req) });
      await audit({ kind: 'capture', uid: out.uid, ms: null, result: 'pass', detail: `share ${out.videoId} ${out.key}` });
      res.status(201).json(out);
    } catch (e) { sendErr(res, e); }
  });

  const verify = async (req, res) => {
    const share = need(ctx, res);
    if (!share) return;
    try {
      const out = await share.check({
        key: one(req.body?.key ?? req.query?.key),
        url: one(req.body?.url ?? req.query?.url),
      });
      const result = out.verdict === 'genuine' ? 'pass' : out.verdict === 'tampered' ? 'fail' : null;
      await audit({
        kind: 'verify', uid: out.uid, ms: null, result,
        detail: `${out.verdict} ${out.key || out.url || ''}`.slice(0, 2000),
      });
      res.json(out);
    } catch (e) { sendErr(res, e); }
  };
  app.get('/api/share/verify', verify);
  app.post('/api/share/verify', verify);

  app.post('/api/share/sweep', async (req, res) => {
    const share = need(ctx, res);
    if (!share) return;
    try {
      share.assertOperator(presentedKey(req));
      const summary = await share.sweep();
      await audit({
        kind: 'verify', uid: null, ms: null,
        result: summary.tampered ? 'fail' : 'pass',
        detail: `sweep genuine=${summary.genuine} tampered=${summary.tampered} unknown=${summary.unknown}`,
      });
      res.json(summary);
    } catch (e) { sendErr(res, e); }
  });
}
