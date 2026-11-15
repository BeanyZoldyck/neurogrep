import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { HttpError } from './errors.js';

const SQL = readFileSync(new URL('../sql/001_vericam_proofs.sql', import.meta.url), 'utf8');

export function sqlStatements(sql) {
  const cleaned = sql.split('\n').map((line) => line.replace(/--.*$/, '')).join('\n');
  return cleaned.split(';').map((part) => part.trim()).filter(Boolean);
}

export async function applySchema(pool, sql = SQL) {
  for (const statement of sqlStatements(sql)) {
    try {
      await pool.query(statement);
    } catch (e) {
      if (/create_hypertable/i.test(statement)) {
        console.error('[proofs] create_hypertable failed (not Timescale?):', String(e.message).split('\n')[0]);
        continue;
      }
      throw e;
    }
  }
}

function asHashes(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) return parsed;
    } catch { /* stored as text */ }
  }
  return [];
}

function mapRow(row) {
  if (!row) return null;
  return {
    time: new Date(row.time),
    video_id: row.video_id,
    object_key: row.object_key,
    public_url: row.public_url,
    uid: row.uid,
    seed: row.seed,
    digest: row.digest,
    payload_sha256: row.payload_sha256,
    width: row.width,
    height: row.height,
    frame_count: row.frame_count,
    frame_hashes: asHashes(row.frame_hashes),
    verdict: row.verdict,
    label: row.label ?? null,
  };
}

const PROOF_SELECT = `time, video_id, object_key, public_url, uid, seed, digest, payload_sha256,
  width, height, frame_count, frame_hashes, verdict, label`;

export function createPgProofs(pool) {
  return {
    enabled: true,
    kind: 'tiger',
    async insert(row) {
      const { rows } = await pool.query(
        `INSERT INTO vericam_proofs
          (time, video_id, object_key, public_url, uid, seed, digest, payload_sha256,
           width, height, frame_count, frame_hashes, verdict, label)
         VALUES (COALESCE($1::timestamptz, now()), $2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13,$14)
         RETURNING time`,
        [
          row.time ?? null, row.video_id, row.object_key, row.public_url, row.uid, row.seed,
          row.digest, row.payload_sha256, row.width, row.height, row.frame_count,
          JSON.stringify(row.frame_hashes), row.verdict, row.label ?? null,
        ],
      );
      return { time: new Date(rows[0].time) };
    },
    async latestByKey(objectKey) {
      const { rows } = await pool.query(
        `SELECT ${PROOF_SELECT} FROM vericam_proofs WHERE object_key = $1 ORDER BY time DESC LIMIT 1`,
        [objectKey],
      );
      return mapRow(rows[0]);
    },
    async latestByUrl(publicUrl) {
      const { rows } = await pool.query(
        `SELECT ${PROOF_SELECT} FROM vericam_proofs WHERE public_url = $1 ORDER BY time DESC LIMIT 1`,
        [publicUrl],
      );
      return mapRow(rows[0]);
    },
    async listRecent(limit) {
      const { rows } = await pool.query(
        `SELECT ${PROOF_SELECT} FROM vericam_proofs ORDER BY time DESC LIMIT $1`,
        [limit],
      );
      return rows.map(mapRow);
    },
    async recordCheck(row) {
      await pool.query(
        `INSERT INTO vericam_proof_checks
          (check_id, object_key, public_url, video_id, verdict, reason, digest, recorded_digest, first_divergent_frame)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          randomUUID(), row.object_key || '', row.public_url || '', row.video_id ?? null,
          row.verdict, row.reason ?? null, row.digest ?? null, row.recorded_digest ?? null,
          row.first_divergent_frame ?? null,
        ],
      );
    },
    async close() {
      await pool.end();
    },
  };
}

export function createMemoryProofs() {
  const rows = [];
  const checks = [];
  return {
    enabled: true,
    kind: 'memory',
    rows,
    checks,
    async insert(row) {
      const saved = {
        ...row,
        time: row.time ? new Date(row.time) : new Date(),
        frame_hashes: [...row.frame_hashes],
        label: row.label ?? null,
      };
      rows.push(saved);
      return { time: saved.time };
    },
    async latestByKey(objectKey) {
      return rows.filter((row) => row.object_key === objectKey).sort((a, b) => b.time - a.time)[0] || null;
    },
    async latestByUrl(publicUrl) {
      return rows.filter((row) => row.public_url === publicUrl).sort((a, b) => b.time - a.time)[0] || null;
    },
    async listRecent(limit) {
      return [...rows].sort((a, b) => b.time - a.time).slice(0, limit);
    },
    async recordCheck(row) {
      checks.push({ time: new Date(), ...row });
    },
    async close() {},
  };
}

export function createDisabledProofs() {
  return {
    enabled: false,
    kind: 'disabled',
    async insert() { throw new HttpError(503, 'TIGER_DATABASE_URL is not set'); },
    async latestByKey() { return null; },
    async latestByUrl() { return null; },
    async listRecent() { return []; },
    async recordCheck() {},
    async close() {},
  };
}

function createUnavailableProofs(message) {
  const fail = async () => { throw new HttpError(503, message); };
  return {
    enabled: false,
    kind: 'error',
    error: message,
    insert: fail,
    latestByKey: fail,
    latestByUrl: fail,
    listRecent: fail,
    recordCheck: fail,
    async close() {},
  };
}

function connectionString(url) {
  return url.replace(/[?&]sslmode=[^&]*/, '');
}

export async function initProofs(env = process.env) {
  const url = (typeof env.TIGER_DATABASE_URL === 'string' && env.TIGER_DATABASE_URL.trim())
    || (typeof env.DATABASE_URL === 'string' && env.DATABASE_URL.trim())
    || '';
  if (!url) {
    console.error('[proofs] TIGER_DATABASE_URL not set; corroboration records disabled');
    return createDisabledProofs();
  }
  const pool = new pg.Pool({
    connectionString: connectionString(url),
    max: 5,
    ssl: /sslmode=disable/.test(url) ? false : { rejectUnauthorized: false },
  });
  pool.on('error', (e) => console.error('[proofs] pool error:', e.message));
  try {
    await applySchema(pool);
    console.error('[proofs] connected');
    return createPgProofs(pool);
  } catch (e) {
    console.error('[proofs] init failed:', e.message);
    await pool.end().catch(() => {});
    return createUnavailableProofs(`Tiger Data is unavailable: ${e.message}`);
  }
}
