import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert, Image, Linking, PermissionsAndroid, Platform, Pressable, SafeAreaView, ScrollView,
  StyleSheet, Text, TextInput, View,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { File, Paths } from 'expo-file-system';
import { Buffer } from 'buffer';
import {
  Camera, useCameraDevice, useCameraFormat, useCameraPermission, useFrameProcessor,
} from 'react-native-vision-camera';
import { Worklets, useSharedValue } from 'react-native-worklets-core';
import { N_FRAMES, chain, eq, hex, seedHash, step } from './src/chain';
import { BleHsm, Hsm, HsmEvent, MODE, MockHsm, onEvent, waitEvent } from './src/hsm';
import { Clip, keepThumb, loadClip, saveClip, thumbBase64 } from './src/store';
import * as api from './src/api';

const OUT_W = 160, OUT_H = 120;
const C = { bg: '#0d1014', fg: '#e6e9ee', mut: '#8b94a3', card: '#161b22', line: '#2a313c', acc: '#4ea1ff', ok: '#2fbf71', bad: '#ff4d5e', warn: '#f5b942' };
type Tab = 'link' | 'capture' | 'arena' | 'verify' | 'stats';
type Banner = { cls: 'ok' | 'bad' | 'wait'; text: string } | null;
const T0 = Date.now();
const jsonHex = (k: string, v: unknown) => (v instanceof Uint8Array ? hex(v) : v);

const TRACKS = [
  ['Gemini API', 'UGC twin generation + natural-language verdict explanation (/api/twin, /api/explain)'],
  ['Solana', 'every burned digest anchored on-chain via a memo tx; explorer link per clip'],
  ['Tiger Data', 'capture/burn/verify events in a Timescale hypertable (/api/events/stats)'],
  ['Vultr', 'hosts the backend + HTTPS reverse proxy'],
  ['MongoDB Atlas', 'clip registry (uid, seed, digest, timeline)'],
  ['DEV writing challenge', 'build write-up of the hardware-bound capture pipeline'],
  ['SpaceXSI / xAI raffle', 'built with Cursor + Grok'],
];

function Btn({ title, onPress, disabled, sec }: { title: string; onPress: () => void; disabled?: boolean; sec?: boolean }) {
  return (
    <Pressable onPress={onPress} disabled={disabled}
      style={[s.btn, sec && { backgroundColor: C.line }, disabled && { opacity: 0.4 }]}>
      <Text style={s.btnT}>{title}</Text>
    </Pressable>
  );
}

// deterministic ±1 LSB re-quantization ("local resynthesis"): visually identical, byte-divergent
function perturb(frames: Uint8Array[]): Uint8Array[] {
  return frames.map((f, i) => {
    const o = new Uint8Array(f.length);
    let x = ((i + 1) * 0x9e3779b9) >>> 0 || 1, bits = 0;
    for (let j = 0; j < f.length; j++) {
      if ((j & 31) === 0) { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; bits = x; }
      const v = f[j] + ((bits >>> (j & 31)) & 1 ? 1 : -1);
      o[j] = v < 0 ? 1 : v > 255 ? 254 : v;
    }
    return o;
  });
}

export default function App() {
  const [tab, setTab] = useState<Tab>('link');
  const [hsm, setHsm] = useState<Hsm | null>(null);
  const [linkName, setLinkName] = useState('');
  const [logs, setLogs] = useState<string[]>([]);
  const [clips, setClips] = useState<{ A: Clip | null; B: Clip | null }>({ A: null, B: null });
  const [sel, setSel] = useState<'A' | 'B'>('A');
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [timeline, setTimeline] = useState<string[]>([]);
  const [capBanner, setCapBanner] = useState<Banner>(null);
  const [verBanner, setVerBanner] = useState<Banner>(null);
  const [verInfo, setVerInfo] = useState('');
  const [explainText, setExplainText] = useState('');
  const [anchor, setAnchor] = useState<api.Anchor>(null);
  const [apiBase, setApiBaseS] = useState(api.DEFAULT_API);
  const [stats, setStats] = useState('');
  const [pf, setPf] = useState<'rgb' | 'yuv'>(Platform.OS === 'android' ? 'yuv' : 'rgb');

  const log = useCallback((m: string) => {
    setLogs((l) => [`[${String(Date.now() - T0).padStart(7)}] ${m}`, ...l].slice(0, 200));
  }, []);
  useEffect(() => { onEvent((e) => log('HSM ⇐ ' + JSON.stringify(e, jsonHex))); }, [log]);
  useEffect(() => { setClips({ A: loadClip('A'), B: loadClip('B') }); }, []);
  useEffect(() => { api.setApiBase(apiBase); }, [apiBase]);
  const setClip = (k: 'A' | 'B', c: Clip) => { setClips((p) => ({ ...p, [k]: c })); saveClip(k, c); };

  // ---------- link ----------
  const linking = useRef(false);
  async function link(h: Hsm) {
    if (linking.current) return; // ignore repeat taps while a scan is running
    linking.current = true; setBusy(true);
    try {
      if (h instanceof BleHsm && Platform.OS === 'android') {
        const r = await PermissionsAndroid.requestMultiple([
          PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN, PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
          PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
        ]);
        log('BLE perms ' + JSON.stringify(r));
      }
      // ESP32 accepts one central and stops advertising while linked: drop the old link before scanning.
      if (hsm) { hsm.disconnect?.(); setHsm(null); setLinkName(''); await new Promise((r) => setTimeout(r, 1200)); }
      const n = await h.connect(); setHsm(h); setLinkName(n); log('linked ' + n);
    } catch (e: any) { log('link error: ' + e.message); Alert.alert('Link failed', e.message); }
    finally { linking.current = false; setBusy(false); }
  }
  const onBleDisconnect = () => { setHsm(null); setLinkName(''); log('BLE disconnected'); };

  // ---------- camera ----------
  const camera = useRef<Camera>(null);
  const device = useCameraDevice('back');
  const format = useCameraFormat(device, [{ fps: 30 }, { videoResolution: { width: 640, height: 480 } }]);
  const { hasPermission, requestPermission } = useCameraPermission();
  useEffect(() => { if (!hasPermission) requestPermission(); }, [hasPermission, requestPermission]);

  const capturing = useSharedValue(false);
  const fIdx = useSharedValue(0);
  const fT0 = useSharedValue(0);
  const sink = useRef<((px: Uint8Array, i: number, w: number, h: number, f: string) => void) | null>(null);
  // worklets-core can't share ArrayBuffers across runtimes; strings cross cheaply (1 char = 1 byte).
  const onFrameJS = useMemo(() => Worklets.createRunOnJS((str: string, i: number, w: number, h: number, f: string) => {
    const px = new Uint8Array(str.length);
    for (let k = 0; k < str.length; k++) px[k] = str.charCodeAt(k);
    sink.current?.(px, i, w, h, f);
  }), []);
  const frameProcessor = useFrameProcessor((frame) => {
    'worklet';
    if (!capturing.value) return;
    const i = fIdx.value;
    if (i >= N_FRAMES) { capturing.value = false; return; }
    // consecutive frames at the camera's native 30 fps (25 frames ≈ 833 ms)
    fIdx.value = i + 1;
    // 160×120 luma grid sampled from the live frame (Y plane for yuv, G channel for rgb)
    const src = new Uint8Array(frame.toArrayBuffer());
    const W = frame.width, H = frame.height, stride = frame.bytesPerRow;
    const bpp = frame.pixelFormat === 'rgb' ? 4 : 1, off = bpp === 4 ? 1 : 0;
    const row: number[] = new Array(OUT_W);
    let str = '';
    for (let y = 0; y < OUT_H; y++) {
      const base = Math.floor((y * H) / OUT_H) * stride;
      for (let x = 0; x < OUT_W; x++) row[x] = src[base + Math.floor((x * W) / OUT_W) * bpp + off];
      str += String.fromCharCode.apply(null, row);
    }
    onFrameJS(str, i, OUT_W, OUT_H, 'y8');
  }, [onFrameJS]);

  const fps = 30;
  const camActive = tab === 'capture';
  const camEl = useMemo(() => device ? (
    <Camera ref={camera} style={s.cam} device={device} format={format} fps={fps} isActive={camActive}
      video={Platform.OS === 'ios'} pixelFormat={pf} frameProcessor={frameProcessor}
      videoStabilizationMode="off" enableBufferCompression />
  ) : null, [device, format, fps, camActive, pf, frameProcessor]);

  // ---------- capture ----------
  async function capture() {
    if (!hsm) return;
    setBusy(true); setProgress(0); setTimeline([]); setAnchor(null);
    try {
      await hsm.arm(MODE.CAPTURE);
      setCapBanner({ cls: 'wait', text: 'CAPTURE ARMED — hold card on reader' });
      const card = await waitEvent((e) => (e.type === 'card' && e.mode === 1) || e.type === 'fail', 60000);
      if (card.type === 'fail') throw new Error(card.why);
      if (card.type !== 'card') throw new Error('unexpected event');
      const t0 = Date.now();
      const tl = [`T=0 card ${hex(card.uid)} state ${hex(card.data).slice(0, 16)}… window ${card.windowMs}ms`];
      let h = seedHash(card.uid, card.data);
      const frames: Uint8Array[] = [];
      let meta = { w: 0, h: 0, f: pf as string };
      const done = new Promise<void>((res, rej) => {
        const to = setTimeout(() => rej(new Error('camera delivered ' + frames.length + '/' + N_FRAMES + ' frames')), 3000);
        sink.current = (px, i, w, hh, f) => {
          if (i !== frames.length) return; // ordering guard
          frames.push(px); h = step(h, i, px); meta = { w, h: hh, f };
          if ((i + 1) % 5 === 0 || i + 1 === N_FRAMES) setProgress((i + 1) / N_FRAMES);
          if (frames.length === N_FRAMES) { clearTimeout(to); res(); }
        };
      });
      fIdx.value = 0; fT0.value = t0; capturing.value = true;
      try { await done; } finally { capturing.value = false; sink.current = null; }
      { const dt = Date.now() - t0; tl.push(`T=${dt} ${N_FRAMES} frames chained (${meta.w}×${meta.h} ${meta.f}, ~${(N_FRAMES * 1000 / dt).toFixed(1)} fps)`); }
      const okP = waitEvent((e) => e.type === 'ok' || e.type === 'fail', 3000);
      await hsm.sendDigest(h);
      tl.push(`T=${Date.now() - t0} digest sent ${hex(h).slice(0, 16)}…`);
      const r = await okP;
      if (r.type === 'fail') throw new Error('HSM rejected burn: ' + r.why);
      if (r.type !== 'ok') throw new Error('unexpected event');
      tl.push(`HSM: digest received @${r.tDigest}ms, burned+readback @${r.tTotal}ms`);
      let thumb: string | null = null;
      try {
        const snap = await camera.current?.takeSnapshot({ quality: 70 });
        if (snap) thumb = keepThumb(snap.path, `thumbA-${Date.now()}.jpg`);
      } catch (e: any) { log('snapshot failed: ' + e.message); }
      const clip: Clip = { label: 'on-site ' + new Date().toLocaleTimeString(), uid: card.uid, seed: card.data, digest: h,
        w: meta.w, h: meta.h, pixelFormat: meta.f, frames, timeline: tl, thumb };
      setClip('A', clip); setTimeline(tl); tl.forEach(log);
      setCapBanner({ cls: 'ok', text: `✅ CAPTURED & BURNED to S50 Sector 1 (${r.tTotal} ms)` });
      api.postEvent({ kind: 'burn', uid: hex(card.uid), ms: r.tTotal, result: 'pass', detail: tl.join(' | ') });
      api.postClip({ label: clip.label, uid: hex(clip.uid), seed: hex(clip.seed), digest: hex(h), w: clip.w, h: clip.h, n: frames.length, timeline: tl })
        .then((res) => { if (res) { log('registered clip ' + res.id); setAnchor(res.anchor); } else log('backend offline — clip kept locally'); });
    } catch (e: any) {
      log('capture failed: ' + e.message);
      setCapBanner({ cls: 'bad', text: '❌ CAPTURE FAILED — ' + e.message });
      api.postEvent({ kind: 'fail', uid: '', ms: 0, result: 'fail', detail: 'capture: ' + e.message });
    }
    setBusy(false);
  }

  // ---------- twin ----------
  async function makeTwin(useApi: boolean) {
    const A = clips.A; if (!A) return;
    setBusy(true);
    try {
      let thumb = A.thumb; let label = 'UGC twin (local resynthesis)';
      if (useApi && A.thumb) {
        const b = thumbBase64(A.thumb);
        const r = b ? await api.twin({ width: A.w, height: A.h, frames: ['data:image/jpeg;base64,' + b] }) : null;
        const u = r?.frames?.[0];
        if (u && u.startsWith('data:')) {
          const f = new File(Paths.document, 'clips', `thumbB-${Date.now()}.jpg`);
          f.write(new Uint8Array(Buffer.from(u.split(',')[1], 'base64')));
          thumb = f.uri; label = 'UGC twin (Gemini thumb + local resynthesis)';
        } else log('twin API unavailable — local resynthesis only');
      }
      // twin claims A's provenance: same uid, seed, and claimed digest
      setClip('B', { ...A, label, frames: perturb(A.frames), thumb, timeline: [] });
      log('twin B ready: ' + label);
    } catch (e: any) { log('twin failed: ' + e.message); }
    setBusy(false);
  }

  // ---------- verify ----------
  async function verify() {
    const c = clips[sel]; if (!hsm) return;
    if (!c) { Alert.alert('Video ' + sel + ' is empty'); return; }
    setBusy(true); setVerInfo(''); setExplainText('');
    try {
      await hsm.arm(MODE.VERIFY);
      setVerBanner({ cls: 'wait', text: 'VERIFY ARMED — tap the S50 card' });
      const card = await waitEvent((e) => (e.type === 'card' && e.mode === 2) || e.type === 'fail', 60000);
      if (card.type === 'fail') throw new Error(card.why);
      if (card.type !== 'card') throw new Error('unexpected event');
      const t = Date.now(); const h = chain(c.uid, c.seed, c.frames); const dt = Date.now() - t;
      const uidOk = eq(card.uid, c.uid), hashOk = eq(card.data, h), pass = uidOk && hashOk;
      setVerInfo(`card uid ${hex(card.uid)} ${uidOk ? '=' : '≠'} clip uid ${hex(c.uid)}\ncard Sector1 B4–5 ${hex(card.data)}\nrecomputed chain  ${hex(h)} (${dt} ms)`);
      setVerBanner(pass ? { cls: 'ok', text: '✅ HARDWARE VERIFIED' } : { cls: 'bad', text: '❌ UGC / SYNTHETIC INJECTION REJECTED' });
      log(`${sel}: ${pass ? 'PASS' : 'FAIL (' + (uidOk ? 'hash chain diverges' : 'uid mismatch') + ')'}`);
      api.postEvent({ kind: 'verify', uid: hex(card.uid), ms: dt, result: pass ? 'pass' : 'fail', detail: `${sel} ${c.label}` });
      api.explain({ result: pass ? 'pass' : 'fail', uidOk, hashOk, cardHex: hex(card.data), chainHex: hex(h), label: c.label })
        .then((r) => r?.text && setExplainText(r.text));
    } catch (e: any) {
      setVerBanner({ cls: 'bad', text: '❌ VERIFY ERROR — ' + e.message }); log('verify failed: ' + e.message);
      api.postEvent({ kind: 'fail', uid: '', ms: 0, result: 'fail', detail: 'verify: ' + e.message });
    }
    setBusy(false);
  }

  async function loadStats() {
    const r = await api.getStats();
    setStats(r ? JSON.stringify(r, null, 2) : 'backend unreachable');
  }

  // ---------- UI ----------
  const BannerV = ({ b }: { b: Banner }) => b && (
    <View style={[s.banner, { borderColor: C[b.cls === 'wait' ? 'warn' : b.cls], borderStyle: b.cls === 'wait' ? 'dashed' : 'solid' }]}>
      <Text style={[s.bannerT, { color: C[b.cls === 'wait' ? 'warn' : b.cls] }]}>{b.text}</Text>
    </View>
  );
  const ClipCard = ({ k }: { k: 'A' | 'B' }) => {
    const c = clips[k];
    return (
      <Pressable onPress={() => { setSel(k); setVerBanner(null); }} style={[s.clip, sel === k && { borderColor: C.acc }]}>
        <Text style={s.bold}>{k === 'A' ? 'Video A · on-site' : 'Video B · UGC twin'}</Text>
        {c?.thumb ? <Image source={{ uri: c.thumb }} style={s.thumb} /> : <View style={[s.thumb, { backgroundColor: '#000' }]} />}
        <Text style={s.hex}>{c ? `${c.label}\nuid ${hex(c.uid)} · ${c.frames.length}f ${c.w}×${c.h} ${c.pixelFormat}\nclaimed ${c.digest ? hex(c.digest).slice(0, 24) + '…' : '—'}` : 'empty'}</Text>
      </Pressable>
    );
  };

  return (
    <SafeAreaView style={s.root}>
      <StatusBar style="light" />
      <View style={s.header}>
        <Text style={s.h1}>Provenance</Text>
        <Text style={[s.pill, hsm && { backgroundColor: C.ok, color: '#000' }]}>{hsm ? 'linked: ' + linkName : 'disconnected'}</Text>
      </View>
      <View style={s.tabs}>
        {(['link', 'capture', 'arena', 'verify', 'stats'] as Tab[]).map((t) => (
          <Pressable key={t} onPress={() => setTab(t)} style={[s.tab, tab === t && { borderBottomColor: C.acc }]}>
            <Text style={[s.tabT, tab === t && { color: C.fg }]}>{t}</Text>
          </Pressable>
        ))}
      </View>
      {hsm instanceof MockHsm && <View style={s.row}><Btn title="Tap virtual card" sec onPress={() => hsm.tap?.()} /></View>}

      {tab === 'capture' && (
        <View style={s.sec}>
          {device && hasPermission ? (
            camEl
          ) : <Text style={s.mut}>{hasPermission ? 'no camera device' : 'camera permission required'}</Text>}
          <View style={s.row}>
            <Btn title="Arm capture → tap card" disabled={!hsm || !device || busy} onPress={capture} />
            <Btn title={'pixel: ' + pf} sec onPress={() => setPf(pf === 'rgb' ? 'yuv' : 'rgb')} />
          </View>
          <View style={s.bar}><View style={[s.barFill, { width: `${progress * 100}%` }]} /></View>
          <BannerV b={capBanner} />
          {anchor && <Text style={[s.hex, { color: C.acc }]} onPress={() => Linking.openURL(anchor.explorer)}>Solana anchor {anchor.signature.slice(0, 16)}… ↗</Text>}
        </View>
      )}

      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 12 }}>
        {tab === 'link' && (
          <View style={s.sec}>
            <Text style={s.h2}>HSM link</Text>
            <View style={s.row}>
              <Btn title="Connect VeriCam-HSM (BLE)" disabled={busy} onPress={() => link(new BleHsm(onBleDisconnect))} />
              <Btn title="Demo (virtual card)" sec onPress={() => link(new MockHsm())} />
            </View>
            <Text style={[s.h2, { marginTop: 12 }]}>API base</Text>
            <TextInput style={s.input} value={apiBase} onChangeText={setApiBaseS} autoCapitalize="none" autoCorrect={false} />
          </View>
        )}
        {tab === 'capture' && (
          <View style={s.sec}><Text style={s.h2}>Timeline</Text><Text style={s.hex}>{timeline.join('\n') || '—'}</Text></View>
        )}
        {tab === 'arena' && (
          <View style={s.sec}>
            <Text style={s.h2}>Arena</Text>
            <View style={{ flexDirection: 'row', gap: 8 }}><ClipCard k="A" /><ClipCard k="B" /></View>
            <View style={s.row}>
              <Btn title="Generate UGC twin" sec disabled={!clips.A || busy} onPress={() => makeTwin(false)} />
              <Btn title="Twin via API (Gemini)" sec disabled={!clips.A || busy} onPress={() => makeTwin(true)} />
            </View>
            <Text style={s.mut}>Twin = A's frames re-quantized by deterministic ±1 LSB noise; it claims A's uid/seed/digest.</Text>
          </View>
        )}
        {tab === 'verify' && (
          <View style={s.sec}>
            <Text style={s.h2}>Judge verification</Text>
            <View style={{ flexDirection: 'row', gap: 8 }}><ClipCard k="A" /><ClipCard k="B" /></View>
            <View style={s.row}><Btn title={`Arm verify (Video ${sel}) → tap card`} disabled={!hsm || busy} onPress={verify} /></View>
            <BannerV b={verBanner} />
            {!!verInfo && <Text style={s.hex}>{verInfo}</Text>}
            {!!explainText && <Text style={[s.mut, { marginTop: 8 }]}>Gemini: {explainText}</Text>}
          </View>
        )}
        {tab === 'stats' && (
          <>
            <View style={s.sec}>
              <Text style={s.h2}>Stats (Tiger Data)</Text>
              <Btn title="Refresh /api/events/stats" sec onPress={loadStats} />
              <Text style={s.hex}>{stats || '—'}</Text>
            </View>
            <View style={s.sec}>
              <Text style={s.h2}>Tracks</Text>
              {TRACKS.map(([k, v]) => <Text key={k} style={s.mut}><Text style={s.bold}>{k}</Text> — {v}</Text>)}
            </View>
          </>
        )}
        <View style={s.sec}><Text style={s.h2}>Log</Text><Text style={s.hex}>{logs.join('\n')}</Text></View>
      </ScrollView>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.bg, paddingTop: Platform.OS === 'android' ? 32 : 0 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 12, paddingVertical: 6 },
  h1: { color: C.fg, fontSize: 20, fontWeight: '800' },
  h2: { color: C.mut, fontSize: 12, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 6 },
  pill: { color: C.fg, backgroundColor: C.line, paddingHorizontal: 8, paddingVertical: 3, borderRadius: 99, fontSize: 12, overflow: 'hidden' },
  tabs: { flexDirection: 'row', borderBottomWidth: 1, borderBottomColor: C.line },
  tab: { flex: 1, paddingVertical: 10, alignItems: 'center', borderBottomWidth: 2, borderBottomColor: 'transparent' },
  tabT: { color: C.mut, fontWeight: '600', textTransform: 'capitalize' },
  sec: { backgroundColor: C.card, borderColor: C.line, borderWidth: 1, borderRadius: 10, padding: 12, marginBottom: 12, marginHorizontal: 0 },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginVertical: 6, paddingHorizontal: 4 },
  btn: { backgroundColor: C.acc, borderRadius: 8, paddingVertical: 10, paddingHorizontal: 14 },
  btnT: { color: '#fff', fontWeight: '600' },
  input: { backgroundColor: C.bg, borderColor: C.line, borderWidth: 1, color: C.fg, borderRadius: 6, padding: 8 },
  cam: { width: '100%', aspectRatio: 4 / 3, borderRadius: 8, overflow: 'hidden' },
  bar: { height: 6, backgroundColor: C.line, borderRadius: 3, overflow: 'hidden', marginTop: 6 },
  barFill: { height: '100%', backgroundColor: C.acc },
  banner: { borderWidth: 2, borderRadius: 10, padding: 18, marginTop: 8, alignItems: 'center' },
  bannerT: { fontSize: 20, fontWeight: '800', textAlign: 'center' },
  clip: { flex: 1, borderWidth: 2, borderColor: C.line, borderRadius: 10, padding: 6 },
  thumb: { width: '100%', aspectRatio: 4 / 3, borderRadius: 6, marginVertical: 4 },
  bold: { color: C.fg, fontWeight: '700' },
  mut: { color: C.mut, fontSize: 13, marginTop: 4 },
  hex: { color: C.mut, fontFamily: Platform.select({ ios: 'Menlo', default: 'monospace' }), fontSize: 11, marginTop: 4 },
});
