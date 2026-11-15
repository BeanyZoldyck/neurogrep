import pg from 'pg';

let pool = null;
const mem = [];

export const enabled = () => !!pool;

export async function init() {
  const url = process.env.TIGER_DATABASE_URL;
  if (!url) return console.log('[tiger] TIGER_DATABASE_URL not set; using in-memory events');
  try {
    pool = new pg.Pool({ connectionString: url.replace(/[?&]sslmode=[^&]*/, ""), max: 5, ssl: /sslmode=disable/.test(url) ? false : { rejectUnauthorized: false } });
    await pool.query(`CREATE TABLE IF NOT EXISTS vericam_events(
      time timestamptz NOT NULL DEFAULT now(), kind text, uid text, ms int, result text, detail text)`);
    try { await pool.query(`SELECT create_hypertable('vericam_events','time', if_not_exists => true)`); }
    catch (e) { console.error('[tiger] create_hypertable failed (not Timescale?):', e.message); }
    console.log('[tiger] connected');
  } catch (e) {
    console.error('[tiger] init failed, using in-memory:', e.message);
    pool = null;
  }
}

export async function insertEvent(ev) {
  if (pool) {
    try {
      await pool.query('INSERT INTO vericam_events(kind,uid,ms,result,detail) VALUES ($1,$2,$3,$4,$5)',
        [ev.kind, ev.uid, ev.ms, ev.result, ev.detail]);
      return;
    } catch (e) { console.error('[tiger] insert failed, buffering in memory:', e.message); }
  }
  mem.push({ time: new Date(), ...ev });
  if (mem.length > 10000) mem.splice(0, mem.length - 10000);
}

const SQL = (bucketExpr) => `
  SELECT ${bucketExpr} AS bucket,
    count(*)::int AS total,
    count(*) FILTER (WHERE kind='capture')::int AS capture,
    count(*) FILTER (WHERE kind='burn')::int AS burn,
    count(*) FILTER (WHERE kind='verify')::int AS verify,
    count(*) FILTER (WHERE kind='fail')::int AS fail,
    count(*) FILTER (WHERE result='pass')::int AS pass,
    count(*) FILTER (WHERE result='fail')::int AS "resultFail",
    round(avg(ms))::int AS "avgMs"
  FROM vericam_events WHERE time > now() - interval '24 hours'
  GROUP BY 1 ORDER BY 1`;

const shape = (r) => ({
  bucket: new Date(r.bucket).toISOString(),
  total: r.total,
  counts: { capture: r.capture, burn: r.burn, verify: r.verify, fail: r.fail },
  pass: r.pass, fail: r.resultFail, avgMs: r.avgMs,
});

export async function stats() {
  if (pool) {
    try {
      let rows;
      try { ({ rows } = await pool.query(SQL(`time_bucket('1 hour', time)`))); }
      catch { ({ rows } = await pool.query(SQL(`date_trunc('hour', time)`))); }
      return { source: 'tiger', buckets: rows.map(shape) };
    } catch (e) { console.error('[tiger] stats failed:', e.message); }
  }
  const since = Date.now() - 864e5, by = new Map();
  for (const e of mem) {
    const t = +e.time; if (t < since) continue;
    const k = Math.floor(t / 36e5) * 36e5;
    const b = by.get(k) || { bucket: k, total: 0, capture: 0, burn: 0, verify: 0, fail: 0, pass: 0, resultFail: 0, msSum: 0, msN: 0 };
    b.total++; b[e.kind]++;
    if (e.result === 'pass') b.pass++; else if (e.result === 'fail') b.resultFail++;
    if (e.ms != null) { b.msSum += e.ms; b.msN++; }
    by.set(k, b);
  }
  const buckets = [...by.values()].sort((a, b) => a.bucket - b.bucket)
    .map((b) => shape({ ...b, avgMs: b.msN ? Math.round(b.msSum / b.msN) : null }));
  return { source: 'memory', buckets };
}
