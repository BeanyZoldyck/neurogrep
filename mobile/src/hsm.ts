// HSM transports: BLE (react-native-ble-plx) and a mock virtual S50 card.
// Protocol: see firmware/vericam-hsm/vericam_hsm/vericam_hsm.ino header.
import { BleManager, ConnectionPriority, Device, Subscription } from 'react-native-ble-plx';
import { Buffer } from 'buffer';
import { File, Paths } from 'expo-file-system';
import { hex, randomBytes } from './chain';

export const SVC = '7e1a0001-5c3b-4c6e-9f2a-0e5a1c0de001';
export const CMD = '7e1a0002-5c3b-4c6e-9f2a-0e5a1c0de001';
export const EVT = '7e1a0003-5c3b-4c6e-9f2a-0e5a1c0de001';
export const DIG = '7e1a0004-5c3b-4c6e-9f2a-0e5a1c0de001';
export const MODE = { IDLE: 0, CAPTURE: 1, VERIFY: 2 } as const;
// Flashed ESP32-CAM firmware (firmware/vericam/src/main.cpp): polled 54-byte state.
export const CAM_SVC = 'f3641400-00b0-4240-ba50-05ca45bf8abc';
export const CAM_CMD = 'f3641401-00b0-4240-ba50-05ca45bf8abc';
export const CAM_STATE = 'f3641402-00b0-4240-ba50-05ca45bf8abc';
export const CAM_ERRORS: Record<number, string> = {
  0x80: 'RC522 not detected (check wiring)', 0x81: 'not a MIFARE Classic 1K card', 0x82: 'card auth/read failed',
  0x83: '1,100 ms deadline exceeded', 0x84: 'no card within 15 s (lift and re-tap)', 0x85: 'digest packet order invalid',
  0x86: 'card write/readback failed', 0x87: 'card written but outside 1,100 ms window',
};
export const FAIL_REASONS: Record<number, string> = {
  1: 'deadline missed (RF window closed)', 2: 'card auth/read failed', 3: 'card write failed',
  4: 'readback mismatch', 5: 'HSM not waiting for digest',
};

export type HsmEvent =
  | { type: 'card'; mode: number; uid: Uint8Array; data: Uint8Array; windowMs: number }
  | { type: 'ok'; tDigest: number; tTotal: number }
  | { type: 'fail'; reason: number; why: string }
  | { type: 'armed'; mode: number }
  | { type: 'unknown'; raw: Uint8Array };

// identical to web parse()
export function parse(u: Uint8Array): HsmEvent {
  switch (u[0]) {
    case 0x10: return { type: 'card', mode: u[1], uid: u.slice(3, 3 + u[2]), data: u.slice(13, 45), windowMs: u[45] | (u[46] << 8) };
    case 0x11: return { type: 'ok', tDigest: u[1] | (u[2] << 8), tTotal: u[3] | (u[4] << 8) };
    case 0x12: return { type: 'fail', reason: u[1], why: FAIL_REASONS[u[1]] };
    case 0x13: return { type: 'armed', mode: u[1] };
  }
  return { type: 'unknown', raw: u };
}

// ---------- event bus ----------
type Waiter = { pred: (e: HsmEvent) => boolean; res: (e: HsmEvent) => void; t: ReturnType<typeof setTimeout> };
let waiters: Waiter[] = [];
let listener: (e: HsmEvent) => void = () => {};
export const onEvent = (f: (e: HsmEvent) => void) => { listener = f; };
export function emit(ev: HsmEvent) {
  listener(ev);
  waiters = waiters.filter((w) => { if (w.pred(ev)) { clearTimeout(w.t); w.res(ev); return false; } return true; });
}
export function waitEvent(pred: (e: HsmEvent) => boolean, ms: number): Promise<HsmEvent> {
  return new Promise((res, rej) => {
    const w: Waiter = { pred, res, t: setTimeout(() => { waiters = waiters.filter((x) => x !== w); rej(new Error('timeout')); }, ms) };
    waiters.push(w);
  });
}

export interface Hsm {
  connect(): Promise<string>;
  arm(m: number): Promise<void>;
  sendDigest(d: Uint8Array): Promise<void>;
  tap?(): void;
  disconnect?(): void;
}

// ---------- BLE ----------
let manager: BleManager | null = null;
const mgr = () => (manager ??= new BleManager());
const b64 = (u: Uint8Array) => Buffer.from(u).toString('base64');

export class BleHsm implements Hsm {
  dev: Device | null = null;
  sub: Subscription | null = null;
  cam = false;               // true → flashed ESP32-CAM polled-state protocol
  session: Uint8Array = new Uint8Array(4);
  polling = 0;               // generation counter; bump to stop a poll loop
  t0 = 0;                    // phone time the card event was emitted
  tDigest = 0;
  constructor(private onDisconnect: () => void) {}
  connect(): Promise<string> {
    const m = mgr();
    m.stopDeviceScan(); // a leftover scan makes Android refuse a new one
    return new Promise((resolve, reject) => {
      const to = setTimeout(() => { m.stopDeviceScan(); reject(new Error('no VeriCam-HSM found (15 s scan)')); }, 15000);
      m.startDeviceScan(null, null, async (err, d) => {
        if (err) { clearTimeout(to); m.stopDeviceScan(); reject(err); return; }
        const name = d?.name || d?.localName || '';
        if (!d || !name.startsWith('VeriCam')) return;
        m.stopDeviceScan(); clearTimeout(to);
        try {
          let dev = await d.connect();
          try { dev = await dev.requestMTU(185); } catch {}
          // 7.5 ms connection interval: GATT round trips drop from ~100 ms to ~15 ms
          try { dev = await dev.requestConnectionPriority(ConnectionPriority.High); } catch {}
          dev = await dev.discoverAllServicesAndCharacteristics();
          this.dev = dev;
          dev.onDisconnected(() => { this.polling++; if (!this.closed) this.onDisconnect(); });
          const svcs = (await dev.services()).map((x) => x.uuid.toLowerCase());
          this.cam = svcs.includes(CAM_SVC);
          if (!this.cam) {
            this.sub = dev.monitorCharacteristicForService(SVC, EVT, (e, c) => {
              if (e || !c?.value) return;
              emit(parse(new Uint8Array(Buffer.from(c.value, 'base64'))));
            });
          } else await this.readState();
          resolve(name + (this.cam ? ' (ESP32-CAM)' : ''));
        } catch (e) { reject(e); }
      });
    });
  }
  // ---- ESP32-CAM protocol helpers ----
  private async camWrite(u: Uint8Array) { await this.dev!.writeCharacteristicWithResponseForService(CAM_SVC, CAM_CMD, b64(u)); }
  private async readState() {
    const c = await this.dev!.readCharacteristicForService(CAM_SVC, CAM_STATE);
    const b = new Uint8Array(Buffer.from(c.value || '', 'base64'));
    if (b.length !== 54 || b[0] !== 1) throw new Error('unsupported ESP32 firmware protocol');
    return { status: b[1], op: b[3], session: b.slice(4, 8), elapsed: b[8] | (b[9] << 8) | (b[10] << 16) | (b[11] << 24),
      uid: b.slice(12, 12 + b[2]), data: b.slice(22, 54) };
  }
  // Poll until a terminal status for our session; emits HsmEvents like the notify firmware.
  private async poll(gen: number, mode: number, afterDigest = false) {
    let armed = false;
    while (gen === this.polling && this.dev) {
      let st;
      try { st = await this.readState(); } catch (e: any) { emit({ type: 'fail', reason: 0, why: 'BLE read: ' + e.message }); return; }
      if (gen !== this.polling) return;
      if (st.session.every((x, i) => x === this.session[i])) {
        if (st.status >= 0x80) { emit({ type: 'fail', reason: st.status, why: CAM_ERRORS[st.status] || 'firmware error 0x' + st.status.toString(16) }); return; }
        if (st.status === 1 && !armed) { armed = true; emit({ type: 'armed', mode }); }
        if (!afterDigest && (st.status === 2 || st.status === 4)) {
          this.t0 = Date.now();
          emit({ type: 'card', mode: st.status === 2 ? 1 : 2, uid: st.uid, data: st.data, windowMs: 1100 });
          return; // stop polling: keep the radio free while the phone captures
        }
        if (st.status === 3) { emit({ type: 'ok', tDigest: this.tDigest, tTotal: st.elapsed }); return; }
      }
      await new Promise((r) => setTimeout(r, 5));
    }
  }
  async arm(m: number) {
    if (!this.cam) { await this.dev!.writeCharacteristicWithResponseForService(SVC, CMD, b64(new Uint8Array([m]))); return; }
    const gen = ++this.polling;
    if (m === MODE.IDLE) { await this.camWrite(new Uint8Array([88, ...this.session])); return; } // 'X'
    this.session = randomBytes(4);
    await this.camWrite(new Uint8Array([m === MODE.CAPTURE ? 66 : 82, ...this.session])); // 'B' | 'R'
    this.poll(gen, m);
  }
  async sendDigest(d: Uint8Array) {
    if (!this.cam) {
      try { await this.dev!.writeCharacteristicWithoutResponseForService(SVC, DIG, b64(d)); }
      catch { await this.dev!.writeCharacteristicWithResponseForService(SVC, DIG, b64(d)); }
      return;
    }
    // 'C' + session + offset + 14 digest bytes (20-byte packets, offsets 0/14/28)
    for (const off of [0, 14, 28]) {
      const pkt = new Uint8Array(20);
      pkt[0] = 67; pkt.set(this.session, 1); pkt[5] = off; pkt.set(d.slice(off, off + 14), 6);
      await this.camWrite(pkt);
    }
    this.tDigest = Date.now() - this.t0;
    this.poll(++this.polling, MODE.CAPTURE, true);
  }
  closed = false;
  disconnect() { this.closed = true; this.polling++; this.sub?.remove(); this.dev?.cancelConnection().catch(() => {}); }
}

// ---------- Mock (virtual S50 persisted in documentDirectory/vcam-card.json) ----------
type Card = { uid: number[]; data: number[] };
export class MockHsm implements Hsm {
  mode = 0; window = 1100; waiting = false; t0 = 0;
  to: ReturnType<typeof setTimeout> | null = null;
  file = new File(Paths.document, 'vcam-card.json');
  card: Card;
  constructor() {
    let c: Card | null = null;
    try { if (this.file.exists) c = JSON.parse(this.file.textSync()); } catch {}
    if (!c) { c = { uid: [...randomBytes(4)], data: [...randomBytes(32)] }; this.save(c); }
    this.card = c;
  }
  save(c: Card) { try { this.file.write(JSON.stringify(c)); } catch {} }
  async connect() { return 'virtual S50 ' + hex(new Uint8Array(this.card.uid)); }
  async arm(m: number) { this.mode = m; setTimeout(() => emit({ type: 'armed', mode: m }), 5); }
  tap() {
    if (!this.mode) return;
    const m = this.mode; this.mode = 0; this.t0 = Date.now(); this.waiting = m === 1;
    emit({ type: 'card', mode: m, uid: new Uint8Array(this.card.uid), data: new Uint8Array(this.card.data), windowMs: this.window });
    if (this.waiting) this.to = setTimeout(() => {
      if (this.waiting) { this.waiting = false; emit({ type: 'fail', reason: 1, why: FAIL_REASONS[1] }); }
    }, this.window);
  }
  async sendDigest(d: Uint8Array) {
    if (!this.waiting) { emit({ type: 'fail', reason: 5, why: FAIL_REASONS[5] }); return; }
    this.waiting = false; if (this.to) clearTimeout(this.to);
    const t = Date.now() - this.t0;
    this.card.data = [...d]; this.save(this.card);
    setTimeout(() => emit({ type: 'ok', tDigest: t, tTotal: t + 30 }), 30);
  }
}
