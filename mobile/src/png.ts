// Minimal 8-bit grayscale PNG encoder (stored/uncompressed deflate) for y8 frames → data URI.
import { Buffer } from 'buffer';

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
const crc32 = (b: Uint8Array) => { let c = 0xffffffff; for (const x of b) c = CRC[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const be32 = (n: number) => new Uint8Array([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
const cat = (...a: Uint8Array[]) => { const o = new Uint8Array(a.reduce((s, x) => s + x.length, 0)); let i = 0; for (const x of a) { o.set(x, i); i += x.length; } return o; };
const chunk = (type: string, data: Uint8Array) => {
  const td = cat(new Uint8Array([...type].map((c) => c.charCodeAt(0))), data);
  return cat(be32(data.length), td, be32(crc32(td)));
};

export function grayPng(px: Uint8Array, w: number, h: number): Uint8Array {
  const raw = new Uint8Array(h * (w + 1));
  for (let y = 0; y < h; y++) raw.set(px.subarray(y * w, y * w + w), y * (w + 1) + 1); // filter 0 per row
  let a = 1, b = 0; for (const x of raw) { a = (a + x) % 65521; b = (b + a) % 65521; }
  const blocks: Uint8Array[] = [];
  for (let o = 0; o < raw.length || o === 0; o += 65535) {
    const part = raw.subarray(o, o + 65535), last = o + 65535 >= raw.length ? 1 : 0;
    blocks.push(new Uint8Array([last, part.length & 255, part.length >> 8, ~part.length & 255, (~part.length >> 8) & 255]), part);
    if (last) break;
  }
  const z = cat(new Uint8Array([0x78, 0x01]), ...blocks, be32(((b << 16) | a) >>> 0));
  const ihdr = cat(be32(w), be32(h), new Uint8Array([8, 0, 0, 0, 0]));
  return cat(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', z), chunk('IEND', new Uint8Array()));
}

export const pngBase64 = (px: Uint8Array, w: number, h: number) => Buffer.from(grayPng(px, w, h)).toString('base64');
