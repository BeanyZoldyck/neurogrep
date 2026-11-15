import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createMemoryStore } from '../lib/s3store.js';
import { createMemoryProofs } from '../lib/proofs.js';
import { createShare } from '../lib/share.js';
import { mountShareRoutes } from '../lib/share-http.js';
import { makeEvidence, tamperEvidence } from '../lib/sample-evidence.js';

const KEY = 'test-upload-key';
const evidence = makeEvidence({ label: 'unit' });

function shareWith(store = createMemoryStore(), proofs = createMemoryProofs()) {
  return { store, proofs, share: createShare({ store, proofs, uploadKey: KEY }) };
}

async function withServer(share, fn) {
  const app = express();
  app.use(express.json({ limit: '8mb' }));
  mountShareRoutes(app, { share });
  const server = await new Promise((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  try {
    await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
}

test('publish then corroborate: genuine, tampered, unknown; sweep does not list', async () => {
  const { store, proofs, share } = shareWith();
  let lists = 0;
  store.list = async () => { lists += 1; throw new Error('list called'); };
  await assert.rejects(() => share.publish({ body: evidence, auth: 'nope' }), (err) => err.status === 401);
  await assert.rejects(() => share.publish({ body: { format: 'nope' }, auth: KEY }), (err) => err.status === 400);
  assert.equal(store.objects.size, 0);

  const published = await share.publish({ body: evidence, auth: KEY });
  assert.match(published.key, /^videos\/[0-9a-f-]{36}\.json$/);
  assert.equal(published.url, store.publicUrl(published.key));
  const genuine = await share.check({ key: published.key });
  assert.equal(genuine.verdict, 'genuine');
  assert.equal(genuine.digest, published.digest);
  assert.equal(genuine.firstDivergentFrame, null);
  assert.equal(proofs.checks.at(-1).verdict, 'genuine');

  const byUrl = await share.check({ url: published.url });
  assert.equal(byUrl.verdict, 'genuine');
  await assert.rejects(
    () => share.check({ key: published.key, url: store.publicUrl('videos/other.json') }),
    (err) => err.status === 400,
  );

  await store.overwrite(published.key, Buffer.from(JSON.stringify(tamperEvidence(evidence, 3))));
  const tampered = await share.check({ key: published.key });
  assert.equal(tampered.verdict, 'tampered');
  assert.equal(tampered.firstDivergentFrame, 3);
  assert.notEqual(tampered.digest, tampered.recordedDigest);

  const second = await share.publish({ body: evidence, auth: KEY });
  const bytes = store.objects.get(second.key);
  await store.overwrite(second.key, Buffer.concat([bytes, Buffer.from('\n')]));
  const whitespace = await share.check({ key: second.key });
  assert.equal(whitespace.verdict, 'tampered');
  assert.equal(whitespace.digest, whitespace.recordedDigest);
  assert.equal(whitespace.firstDivergentFrame, null);
  assert.match(whitespace.reason, /payload hash/);

  const unknown = await share.check({ key: 'videos/missing.json' });
  assert.equal(unknown.verdict, 'unknown');
  assert.match(unknown.reason, /no public object/);

  const sweep = await share.sweep();
  assert.equal(lists, 0);
  assert.equal(sweep.listedWithCredentials, false);
  assert.equal(sweep.listError, null);
  assert.equal(sweep.tampered, 2);
  assert.equal(sweep.genuine, 0);
  assert.equal(sweep.unknown, 0);
});

test('credentialed list adds bucket keys that have no Tiger row', async () => {
  const { store, share } = shareWith();
  const published = await share.publish({ body: evidence, auth: KEY });
  store.canList = true;
  store.list = async (prefix) => {
    assert.equal(prefix, 'videos/');
    return [published.key, 'videos/extra.json'];
  };
  const sweep = await share.sweep();
  assert.equal(sweep.listedWithCredentials, true);
  assert.equal(sweep.genuine, 1);
  assert.equal(sweep.unknown, 1);
  assert.equal(sweep.results.find((row) => row.key === 'videos/extra.json').verdict, 'unknown');
});

test('list failure still corroborates Tiger keys', async () => {
  const { store, share } = shareWith();
  const published = await share.publish({ body: evidence, auth: KEY });
  store.canList = true;
  store.list = async () => { throw new Error('AccessDenied'); };
  const sweep = await share.sweep();
  assert.match(sweep.listError, /AccessDenied/);
  assert.equal(sweep.genuine, 1);
  assert.equal(sweep.results[0].key, published.key);
});

test('HTTP upload requires the bearer token and verify stays public', async () => {
  const { share } = shareWith();
  await withServer(share, async (base) => {
    const denied = await fetch(`${base}/api/share/videos`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(evidence),
    });
    assert.equal(denied.status, 401);
    const created = await fetch(`${base}/api/share/videos`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
      body: JSON.stringify({ evidence, label: 'wrapped' }),
    });
    const up = await created.json();
    assert.equal(created.status, 201, JSON.stringify(up));
    const checked = await (await fetch(`${base}/api/share/verify?key=${encodeURIComponent(up.key)}`)).json();
    assert.equal(checked.verdict, 'genuine');
    const outside = await fetch(`${base}/api/share/verify?url=${encodeURIComponent('http://127.0.0.1/secret')}`);
    assert.equal(outside.status, 400);
    const sweep = await fetch(`${base}/api/share/sweep`, { method: 'POST' });
    assert.equal(sweep.status, 401);
  });
});

test('403 from the public bucket is tampered when a record exists', async () => {
  const { store, share } = shareWith();
  const published = await share.publish({ body: evidence, auth: KEY });
  store.fetchPublic = async () => {
    const error = new Error('public object unavailable (HTTP 403)');
    error.status = 403;
    error.code = 'NotFound';
    throw error;
  };
  const out = await share.check({ key: published.key });
  assert.equal(out.verdict, 'tampered');
  assert.match(out.reason, /HTTP 403/);
});
