import { WIDTH, HEIGHT, COUNT } from '../../mobile/core.mjs';

// Synthetic vericam-rgba-v1 document. Valid for verifyEvidence, not a card capture.
export function makeEvidence({ fill = 9, uid = '01020304', seed = '07'.repeat(32), label } = {}) {
  const frames = [];
  for (let i = 0; i < COUNT; i++) {
    frames.push(Buffer.alloc(WIDTH * HEIGHT * 4, (fill + i) & 255).toString('base64'));
  }
  const evidence = { format: 'vericam-rgba-v1', width: WIDTH, height: HEIGHT, uid, seed, frames };
  if (label) evidence.label = label;
  return evidence;
}

export function tamperEvidence(evidence, frameIndex, xor = 0xff) {
  const raw = Buffer.from(evidence.frames[frameIndex], 'base64');
  raw[0] ^= xor;
  const frames = evidence.frames.slice();
  frames[frameIndex] = raw.toString('base64');
  return { ...evidence, frames };
}
