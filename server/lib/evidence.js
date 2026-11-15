import { verifyEvidence, initial, step, frameBytes, unhex, hex, COUNT } from '../../mobile/core.mjs';

// Per-frame hashes use the same initial/step functions as verifyEvidence.
// The final digest is verifyEvidence's return value; the last step must match it.
export async function computeProof(evidence) {
  const digest = hex(await verifyEvidence(evidence));
  let hash = await initial(unhex(evidence.uid), unhex(evidence.seed));
  const frameHashes = [];
  for (let i = 0; i < COUNT; i++) {
    hash = await step(hash, frameBytes(evidence.frames[i]), i);
    frameHashes.push(hex(hash));
  }
  if (frameHashes[COUNT - 1] !== digest) throw Error('frame chain diverged from verifyEvidence');
  return {
    digest,
    frameHashes,
    uid: evidence.uid,
    seed: evidence.seed,
    width: evidence.width,
    height: evidence.height,
    frameCount: COUNT,
  };
}
