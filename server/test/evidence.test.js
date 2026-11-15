import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { verifyEvidence, hex } from '../../mobile/core.mjs';
import { computeProof } from '../lib/evidence.js';
import { makeEvidence, tamperEvidence } from '../lib/sample-evidence.js';

test('computeProof matches verifyEvidence and an independent SHA-256 chain', async () => {
  const evidence = makeEvidence({ fill: 4, uid: '01020304', seed: '07'.repeat(32) });
  const uid = Buffer.from(evidence.uid, 'hex');
  const seed = Buffer.from(evidence.seed, 'hex');
  const frames = evidence.frames.map((frame) => Buffer.from(frame, 'base64'));
  const hash = (bytes) => createHash('sha256').update(bytes).digest();
  let expected = hash(Buffer.concat([
    Buffer.from('VeriCam-v1:160x120:25:RGBA'),
    Buffer.from([uid.length]),
    uid,
    seed,
  ]));
  for (let i = 0; i < frames.length; i++) {
    expected = hash(Buffer.concat([expected, Buffer.from([i]), frames[i]]));
  }
  const proof = await computeProof(evidence);
  assert.equal(proof.digest, expected.toString('hex'));
  assert.equal(proof.frameHashes.at(-1), proof.digest);
  assert.equal(proof.frameHashes.length, 25);
  assert.equal(hex(await verifyEvidence(evidence)), proof.digest);
  const edited = tamperEvidence(evidence, 3);
  assert.notEqual((await computeProof(edited)).digest, proof.digest);
  assert.equal((await computeProof(edited)).frameHashes[2], proof.frameHashes[2]);
  assert.notEqual((await computeProof(edited)).frameHashes[3], proof.frameHashes[3]);
});
