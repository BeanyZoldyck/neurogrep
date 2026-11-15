import express from 'express';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { DEFAULT_PUBLIC_BASE_URL, createMemoryStore } from '../lib/s3store.js';
import { createMemoryProofs } from '../lib/proofs.js';
import { createShare } from '../lib/share.js';
import { mountShareRoutes } from '../lib/share-http.js';
import { makeEvidence, tamperEvidence } from '../lib/sample-evidence.js';

const KEY = 'demo-upload-key';

function expect(cond, message) {
  if (!cond) throw new Error(message);
}

export async function main() {
  console.log('Offline demo. In-memory bucket and in-memory verification records.');
  console.log(`Live public bucket (this demo does not write to it): ${DEFAULT_PUBLIC_BASE_URL}/<key>`);

  const store = createMemoryStore();
  let lists = 0;
  const guarded = {
    ...store,
    async list(...args) {
      lists += 1;
      return store.list(...args);
    },
  };
  const proofs = createMemoryProofs();
  const share = createShare({ store: guarded, proofs, uploadKey: KEY });
  const app = express();
  app.use(express.json({ limit: '8mb' }));
  mountShareRoutes(app, { share });
  const server = await new Promise((resolveListen) => {
    const listening = app.listen(0, '127.0.0.1', () => resolveListen(listening));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const auth = { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' };

  try {
    const evidence = makeEvidence({ label: 'demo clip' });
    const published = await fetch(`${base}/api/share/videos`, {
      method: 'POST', headers: auth, body: JSON.stringify(evidence),
    });
    const up = await published.json();
    expect(published.status === 201, `upload status ${published.status} ${JSON.stringify(up)}`);
    expect(up.verdict === 'genuine', 'upload verdict');

    const genuine = await (await fetch(`${base}/api/share/verify?key=${encodeURIComponent(up.key)}`)).json();
    expect(genuine.verdict === 'genuine', `expected genuine, got ${genuine.verdict}: ${genuine.reason}`);
    console.log(`genuine   ${genuine.key}  digest ${genuine.digest.slice(0, 16)}…`);

    const tamperedDoc = tamperEvidence(evidence, 3);
    await store.overwrite(up.key, Buffer.from(JSON.stringify(tamperedDoc)));
    const tampered = await (await fetch(`${base}/api/share/verify?key=${encodeURIComponent(up.key)}`)).json();
    expect(tampered.verdict === 'tampered', `expected tampered, got ${tampered.verdict}: ${tampered.reason}`);
    expect(tampered.firstDivergentFrame === 3, `divergent frame ${tampered.firstDivergentFrame}`);
    console.log(`tampered  ${tampered.key}  first divergent frame ${tampered.firstDivergentFrame}`);

    const unknown = await (await fetch(`${base}/api/share/verify?key=videos/not-published.json`)).json();
    expect(unknown.verdict === 'unknown', `expected unknown, got ${unknown.verdict}: ${unknown.reason}`);
    console.log(`unknown   videos/not-published.json  ${unknown.reason}`);

    const denied = await fetch(`${base}/api/share/sweep`, { method: 'POST' });
    expect(denied.status === 401, 'sweep without the upload key');
    const sweepRes = await fetch(`${base}/api/share/sweep`, { method: 'POST', headers: auth });
    const sweep = await sweepRes.json();
    expect(sweepRes.status === 200, `sweep status ${sweepRes.status}`);
    expect(sweep.listedWithCredentials === false, 'sweep must not list without credentials');
    expect(lists === 0, 'list() was called');
    expect(sweep.tampered === 1 && sweep.genuine === 0 && sweep.unknown === 0, JSON.stringify(sweep));
    console.log(`sweep     checked=${sweep.checked} genuine=${sweep.genuine} tampered=${sweep.tampered} unknown=${sweep.unknown} listed=${sweep.listedWithCredentials}`);
    console.log('demo ok');
    return 0;
  } finally {
    await new Promise((resolveClose, rejectClose) => {
      server.close((err) => (err ? rejectClose(err) : resolveClose()));
    });
  }
}

const invoked = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invoked) {
  const code = await main().catch((e) => {
    console.error(e.message || e);
    return 1;
  });
  process.exit(code);
}
