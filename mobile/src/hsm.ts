// HSM transports: BLE (react-native-ble-plx) and a mock virtual S50 card.
// Protocol: see firmware/vericam-hsm/vericam_hsm/vericam_hsm.ino header.
import { BleManager, Device, Subscription } from 'react-native-ble-plx';
import { Buffer } from 'buffer';
import { File, Paths } from 'expo-file-system';
import { hex, randomBytes } from './chain';

export const SVC = '7e1a0001-5c3b-4c6e-9f2a-0e5a1c0de001';
export const CMD = '7e1a0002-5c3b-4c6e-9f2a-0e5a1c0de001';
export const EVT = '7e1a0003-5c3b-4c6e-9f2a-0e5a1c0de001';
export const DIG = '7e1a0004-5c3b-4c6e-9f2a-0e5a1c0de001';
export const MODE = { IDLE: 0, CAPTURE: 1, VERIFY: 2 } as const;
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
  constructor(private onDisconnect: () => void) {}
  connect(): Promise<string> {
    const m = mgr();
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
          dev = await dev.discoverAllServicesAndCharacteristics();
          this.dev = dev;
          dev.onDisconnected(() => this.onDisconnect());
          this.sub = dev.monitorCharacteristicForService(SVC, EVT, (e, c) => {
            if (e || !c?.value) return;
            emit(parse(new Uint8Array(Buffer.from(c.value, 'base64'))));
          });
          resolve(name);
        } catch (e) { reject(e); }
      });
    });
  }
  async arm(m: number) { await this.dev!.writeCharacteristicWithResponseForService(SVC, CMD, b64(new Uint8Array([m]))); }
  async sendDigest(d: Uint8Array) {
    try { await this.dev!.writeCharacteristicWithoutResponseForService(SVC, DIG, b64(d)); }
    catch { await this.dev!.writeCharacteristicWithResponseForService(SVC, DIG, b64(d)); }
  }
  disconnect() { this.sub?.remove(); this.dev?.cancelConnection().catch(() => {}); }
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
