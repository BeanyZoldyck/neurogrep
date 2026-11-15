// Clip persistence (expo-file-system). File layout mirrors web .vcam export:
//   u32le(hdrLen) || JSON header || frame_0 || ... || frame_{n-1}
import { Directory, File, Paths } from 'expo-file-system';
import { Buffer } from 'buffer';
import { hex, unhex, u32 } from './chain';

export type Clip = {
  label: string; uid: Uint8Array; seed: Uint8Array; digest: Uint8Array | null;
  w: number; h: number; pixelFormat: string; frames: Uint8Array[]; timeline: string[];
  thumb: string | null; // file:// URI of JPEG snapshot
};

const dir = () => { const d = new Directory(Paths.document, 'clips'); if (!d.exists) d.create({ idempotent: true }); return d; };

export function saveClip(k: string, c: Clip) {
  try {
    const hdr = Buffer.from(JSON.stringify({
      label: c.label, uid: hex(c.uid), seed: hex(c.seed), digest: c.digest ? hex(c.digest) : null,
      w: c.w, h: c.h, pixelFormat: c.pixelFormat, n: c.frames.length, sizes: c.frames.map((f) => f.length),
      timeline: c.timeline, thumb: c.thumb,
    }), 'utf8');
    const total = 4 + hdr.length + c.frames.reduce((s, f) => s + f.length, 0);
    const out = new Uint8Array(total); out.set(u32(hdr.length), 0); out.set(hdr, 4);
    let o = 4 + hdr.length; for (const f of c.frames) { out.set(f, o); o += f.length; }
    new File(dir(), `clip${k}.vcam`).write(out);
  } catch (e) { console.warn('saveClip', e); }
}

export function loadClip(k: string): Clip | null {
  try {
    const f = new File(dir(), `clip${k}.vcam`); if (!f.exists) return null;
    const b = f.bytesSync();
    const n = b[0] | (b[1] << 8) | (b[2] << 16) | (b[3] << 24);
    const m = JSON.parse(Buffer.from(b.subarray(4, 4 + n)).toString('utf8'));
    const frames: Uint8Array[] = []; let o = 4 + n;
    for (const sz of m.sizes as number[]) { frames.push(b.slice(o, o + sz)); o += sz; }
    return { label: m.label, uid: unhex(m.uid), seed: unhex(m.seed), digest: m.digest ? unhex(m.digest) : null,
      w: m.w, h: m.h, pixelFormat: m.pixelFormat, frames, timeline: m.timeline || [], thumb: m.thumb };
  } catch (e) { console.warn('loadClip', e); return null; }
}

// copy a snapshot (path from VisionCamera) into clips dir, return file:// uri
export function keepThumb(path: string, name: string): string | null {
  try {
    const src = new File(path.startsWith('file://') ? path : 'file://' + path);
    const dst = new File(dir(), name);
    if (dst.exists) dst.delete();
    src.copySync(dst);
    return dst.uri;
  } catch (e) { console.warn('keepThumb', e); return null; }
}

export function thumbBase64(uri: string): string | null {
  try { return new File(uri).base64Sync(); } catch { return null; }
}
