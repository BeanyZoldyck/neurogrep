export const SERVICE = 'f3641400-00b0-4240-ba50-05ca45bf8abc';
export const COMMAND = 'f3641401-00b0-4240-ba50-05ca45bf8abc';
export const STATE = 'f3641402-00b0-4240-ba50-05ca45bf8abc';
export const WIDTH = 160, HEIGHT = 120, COUNT = 25;
export const hex = bytes => Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
export function unhex(text) {
  if (typeof text !== 'string' || !/^(?:[0-9a-f]{2})+$/.test(text)) throw Error('Invalid hex');
  return Uint8Array.from(text.match(/../g), b => parseInt(b, 16));
}
export function concat(...arrays) {
  const out = new Uint8Array(arrays.reduce((n, a) => n + a.length, 0));
  let offset = 0;
  for (const a of arrays) { out.set(a, offset); offset += a.length; }
  return out;
}
export const sha = async bytes => new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
export const initial = (uid, seed) => sha(concat(new TextEncoder().encode('VeriCam-v1:160x120:25:RGBA'), Uint8Array.of(uid.length), uid, seed));
export const step = (previous, frame, index) => sha(concat(previous, Uint8Array.of(index), frame));
export function parseState(value) {
  const b = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  if (b.length !== 54 || b[0] !== 1) throw Error('Unsupported firmware protocol');
  return {status:b[1], mode:b[3], session:hex(b.slice(4,8)), elapsed:new DataView(b.buffer,b.byteOffset,b.byteLength).getUint32(8,true), uid:hex(b.slice(12,12+b[2])), bytes:b.slice(22,54)};
}
export async function verifyEvidence(e) {
  if (e?.format !== 'vericam-rgba-v1' || e.width !== WIDTH || e.height !== HEIGHT || !Array.isArray(e.frames) || e.frames.length !== COUNT) throw Error('Invalid evidence format');
  const uid = unhex(e.uid), seed = unhex(e.seed);
  if (![4,7,10].includes(uid.length) || seed.length !== 32) throw Error('Invalid card metadata');
  let hash = await initial(uid, seed);
  for (let i=0;i<COUNT;i++) {
    if (typeof e.frames[i] !== 'string' || e.frames[i].length !== WIDTH*HEIGHT*4*4/3) throw Error('Invalid frame size');
    const frame = Uint8Array.from(atob(e.frames[i]), c=>c.charCodeAt(0));
    if (frame.length !== WIDTH*HEIGHT*4) throw Error('Invalid frame');
    hash = await step(hash, frame, i);
  }
  return hash;
}
