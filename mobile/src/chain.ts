// Hash chain — byte-compatible with web/vericam/index.html
//   seed = SHA256("VeriCam-v1" || uid || cardState32)
//   h_i  = SHA256(h_{i-1} || u32le(i) || frameBytes_i)
import { createHash } from 'react-native-quick-crypto';

export const N_FRAMES = 25;
export const SPAN_MS = 850;
export const FRAME_MS = SPAN_MS / N_FRAMES;

const TAG = new Uint8Array([...'VeriCam-v1'].map((c) => c.charCodeAt(0)));

export function sha(...parts: Uint8Array[]): Uint8Array {
  const h = createHash('sha256');
  for (const p of parts) h.update(p as any);
  const d = h.digest();
  return new Uint8Array(d.buffer, d.byteOffset, d.byteLength).slice();
}
export const u32 = (i: number) => new Uint8Array([i & 255, (i >> 8) & 255, (i >> 16) & 255, (i >>> 24) & 255]);
export const seedHash = (uid: Uint8Array, state: Uint8Array) => sha(TAG, uid, state);
export const step = (h: Uint8Array, i: number, px: Uint8Array) => sha(h, u32(i), px);
export function chain(uid: Uint8Array, state: Uint8Array, frames: Uint8Array[]): Uint8Array {
  let h = seedHash(uid, state);
  for (let i = 0; i < frames.length; i++) h = step(h, i, frames[i]);
  return h;
}

export const hex = (u: Uint8Array) => Array.from(u, (b) => b.toString(16).padStart(2, '0')).join('');
export const unhex = (s: string) => new Uint8Array((s.match(/../g) || []).map((x) => parseInt(x, 16)));
export const eq = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);
export function randomBytes(n: number): Uint8Array {
  const u = new Uint8Array(n);
  for (let i = 0; i < n; i++) u[i] = Math.floor(Math.random() * 256);
  return u;
}
