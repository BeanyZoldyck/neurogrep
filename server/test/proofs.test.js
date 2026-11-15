import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { newDb } from 'pg-mem';
import { applySchema, createPgProofs, sqlStatements } from '../lib/proofs.js';

const SQL = readFileSync(new URL('../sql/001_vericam_proofs.sql', import.meta.url), 'utf8');

function row(overrides) {
  return {
    video_id: '11111111-1111-1111-1111-111111111111',
    object_key: 'videos/abc.json',
    public_url: 'https://neurogrep-public-1794752476.s3.amazonaws.com/videos/abc.json',
    uid: '01020304',
    seed: 'ab'.repeat(32),
    digest: '11'.repeat(32),
    payload_sha256: '22'.repeat(32),
    width: 160,
    height: 120,
    frame_count: 25,
    frame_hashes: Array.from({ length: 25 }, (_, i) => i.toString(16).padStart(64, '0')),
    verdict: 'genuine',
    label: 'clip',
    ...overrides,
  };
}

test('migration declares a time hypertable and per-frame hashes', () => {
  assert.match(SQL, /CREATE TABLE IF NOT EXISTS vericam_proofs/);
  assert.match(SQL, /frame_hashes\s+jsonb/);
  assert.match(SQL, /create_hypertable\('vericam_proofs', 'time'/);
  assert.match(SQL, /create_hypertable\('vericam_proof_checks', 'time'/);
  const statements = sqlStatements(SQL);
  assert.ok(statements.some((statement) => statement.startsWith('CREATE TABLE IF NOT EXISTS vericam_proofs')));
  assert.ok(statements.some((statement) => /create_hypertable\('vericam_proofs'/.test(statement)));
});

test('pg-mem stores a proof and returns the latest row for a key', async () => {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  const pool = new Pool();
  await applySchema(pool, SQL);
  const proofs = createPgProofs(pool);
  try {
    await proofs.insert(row({ time: new Date('2026-01-01T00:00:00Z'), digest: 'aa'.repeat(32) }));
    await proofs.insert(row({
      time: new Date('2026-01-02T00:00:00Z'),
      video_id: '22222222-2222-2222-2222-222222222222',
      digest: 'bb'.repeat(32),
      frame_hashes: Array.from({ length: 25 }, () => 'cc'.repeat(32)),
    }));
    const latest = await proofs.latestByKey('videos/abc.json');
    assert.equal(latest.digest, 'bb'.repeat(32));
    assert.equal(latest.frame_hashes.length, 25);
    assert.equal(latest.frame_hashes[0], 'cc'.repeat(32));
    assert.equal(latest.public_url.includes('neurogrep-public-1794752476.s3.amazonaws.com'), true);
    const recent = await proofs.listRecent(10);
    assert.equal(recent[0].digest, 'bb'.repeat(32));
    await proofs.recordCheck({
      object_key: 'videos/abc.json',
      public_url: latest.public_url,
      video_id: latest.video_id,
      verdict: 'genuine',
      reason: 'match',
      digest: latest.digest,
      recorded_digest: latest.digest,
      first_divergent_frame: null,
    });
    const { rows } = await pool.query('SELECT verdict, object_key FROM vericam_proof_checks');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].verdict, 'genuine');
    assert.equal(rows[0].object_key, 'videos/abc.json');
  } finally {
    await proofs.close();
  }
});
