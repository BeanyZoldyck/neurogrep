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
import { FRAME_MS, N_FRAMES, Segment, chainSegments, eq, hex, seedHash, step } from './src/chain';
import { BleHsm, Hsm, HsmEvent, MODE, onEvent, waitEvent } from './src/hsm';
import { Clip, keepThumb, loadClip, saveClip, thumbBase64 } from './src/store';
import * as api from './src/api';
import { pngBase64 } from './src/png';

const OUT_W = 320, OUT_H = 240;
const C = { bg: '#0d1014', fg: '#e6e9ee', mut: '#8b94a3', card: '#161b22', line: '#2a313c', acc: '#4ea1ff', ok: '#2fbf71', bad: '#ff4d5e', warn: '#f5b942' };
type Tab = 'link' | 'capture' | 'arena' | 'verify';
type Banner = { cls: 'ok' | 'bad' | 'wait'; text: string } | null;
const T0 = Date.now();
const jsonHex = (k: string, v: unknown) => (v instanceof Uint8Array ? hex(v) : v);


function Btn({ title, onPress, disabled, sec }: { title: string; onPress: () => void; disabled?: boolean; sec?: boolean }) {
  return (
    <Pressable onPress={onPress} disabled={disabled}
      style={[s.btn, sec && { backgroundColor: C.line }, disabled && { opacity: 0.4 }]}>
      <Text style={s.btnT}>{title}</Text>
    </Pressable>
  );
}

// Side-by-side playback of the stored chained frames (y8) for Video A and the UGC twin B, in lockstep.
function useFrameUris(c: Clip | null) {
  return useMemo(() => (c && c.pixelFormat === 'y8'
    ? c.frames.filter((f) => f.length === c.w * c.h).map((f) => 'data:image/png;base64,' + pngBase64(f, c.w, c.h))
    : []), [c]);
}
function ComparePlayer({ A, B }: { A: Clip | null; B: Clip | null }) {
  const ua = useFrameUris(A), ub = useFrameUris(B);
  const n = Math.max(ua.length, ub.length);
  const [fi, setFi] = useState(0);
  const [playing, setPlaying] = useState(false);
  useEffect(() => {
    if (!playing || !n) return;
    const t = setInterval(() => setFi((i) => (i + 1) % n), FRAME_MS);
    return () => clearInterval(t);
  }, [playing, n]);
  useEffect(() => { setFi(0); }, [n]);
  const seg = (c: Clip | null, i: number) => {
    if (!c) return '';
    let o = 0; for (let k = 0; k < c.segments.length; k++) { o += c.segments[k].n; if (i < o) return `seg ${k + 1}/${c.segments.length}`; }
    return '';
  };
  // TikTok-style: full-width stacked windows, overlay captions, tap a video to play/pause
  const pane = (label: string, color: string, c: Clip | null, u: string[]) => (
    <Pressable onPress={() => n && setPlaying(!playing)} style={[s.vid, { borderColor: color }]}>
      {u.length ? <Image source={{ uri: u[fi % u.length] }} style={s.vidImg} fadeDuration={0} resizeMode="cover" />
        : c?.thumb ? <Image source={{ uri: c.thumb }} style={s.vidImg} resizeMode="cover" /> : null}
      <Text style={[s.vidTag, { backgroundColor: color }]}>{label}</Text>
      {!playing && !!u.length && <Text style={s.vidPlay}>▶</Text>}
      <Text style={s.vidCap}>{u.length ? `${(fi % u.length) + 1}/${u.length} · ${seg(c, fi % u.length)}` : c ? 'no playable frames' : 'empty — capture first'}</Text>
    </Pressable>
  );
  return (
    <View>
      {pane('🎥 REAL · on-site', C.ok, A, ua)}
      {pane('🤖 UGC TWIN', C.bad, B, ub)}
      <View style={s.row}>
        <Btn title={playing ? '⏸ Pause' : '▶ Play both'} disabled={!n} onPress={() => setPlaying(!playing)} />
        <Btn title="⏮ Restart" sec disabled={!n} onPress={() => setFi(0)} />
        <Btn title="Step ▸" sec disabled={!n || playing} onPress={() => setFi((i) => (i + 1) % n)} />
      </View>
    </View>
  );
}

// deterministic "generative" resynthesis: posterized banding + grain + a drifting smear band, so the
// twin is visibly synthetic while still claiming A's provenance (any byte change breaks the chain).
function perturb(frames: Uint8Array[], w: number): Uint8Array[] {
  return frames.map((f, i) => {
    const o = new Uint8Array(f.length);
    let x = ((i + 1) * 0x9e3779b9) >>> 0 || 1;
    const h = Math.max(1, Math.floor(f.length / Math.max(1, w)));
    const band = Math.floor(((i * 7) % h + h) % h); // smear row drifts down each frame
    for (let j = 0; j < f.length; j++) {
      x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0;
      const row = Math.floor(j / Math.max(1, w));
      const src = Math.abs(row - band) < 6 ? f[j - (j % w) + ((j % w) * 3 >> 2)] ?? f[j] : f[j]; // horizontal smear
      const q = Math.round(src / 32) * 32;                // 8-level banding
      const v = q + ((x & 31) - 16);                      // ±16 grain
      o[j] = v < 0 ? 0 : v > 255 ? 255 : v;
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
  const [maxSeg, setMaxSeg] = useState(4); // chained N_FRAMES-frame segments per recording
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
    // consecutive frames at the camera's native 30 fps (N_FRAMES at 30 fps ≈ 833 ms)
    fIdx.value = i + 1;
    // OUT_W×OUT_H luma grid from the live frame (Y plane for yuv, G channel for rgb); each output
    // pixel is the 2×2 average at the top-left of its source block (box filter: less aliasing/shimmer)
    const src = new Uint8Array(frame.toArrayBuffer());
    const W = frame.width, H = frame.height, stride = frame.bytesPerRow;
    const bpp = frame.pixelFormat === 'rgb' ? 4 : 1, off = bpp === 4 ? 1 : 0;
    const dx = W >= OUT_W * 2 ? bpp : 0, dy = H >= OUT_H * 2 ? stride : 0;
    const row: number[] = new Array(OUT_W);
    let str = '';
    for (let y = 0; y < OUT_H; y++) {
      const base = Math.floor((y * H) / OUT_H) * stride;
      for (let x = 0; x < OUT_W; x++) {
        const p = base + Math.floor((x * W) / OUT_W) * bpp + off;
        row[x] = (src[p] + src[p + dx] + src[p + dy] + src[p + dy + dx] + 2) >> 2;
      }
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
  // Records up to maxSeg chained segments while the card stays on the reader; lifting it stops.
  // Segment k: card read (state = segment k-1's digest) → N_FRAMES frames → digest burned inside 1,500 ms.
  async function capture() {
    if (!hsm) return;
    setBusy(true); setProgress(0); setTimeline([]); setAnchor(null);
    const T = Date.now();
    const tl: string[] = [], segs: Segment[] = [], all: Uint8Array[] = [];
    let uid: Uint8Array | null = null, meta = { w: 0, h: 0, f: pf as string }, lastTotal = 0;
    try {
      for (let k = 0; k < maxSeg; k++) {
        try {
          await hsm.arm(MODE.CAPTURE);
          if (k === 0) setCapBanner({ cls: 'wait', text: `CAPTURE ARMED — hold card on reader (≤${maxSeg} segments; lift to stop)` });
          let card: HsmEvent;
          try {
            card = await waitEvent((e) => (e.type === 'card' && e.mode === 1) || e.type === 'fail', k === 0 ? 60000 : 2000);
          } catch (e) {
            if (k === 0) throw e;
            await hsm.arm(MODE.IDLE).catch(() => {});
            throw new Error('card lifted');
          }
          if (card.type === 'fail') throw new Error(card.why);
          if (card.type !== 'card') throw new Error('unexpected event');
          const t0 = Date.now();
          if (uid && !eq(card.uid, uid)) throw new Error('different card presented');
          if (k > 0 && !eq(card.data, segs[k - 1].digest)) throw new Error('card state ≠ previous segment digest');
          uid = card.uid;
          tl.push(`T=${t0 - T} seg ${k + 1}: card ${hex(card.uid)} state ${hex(card.data).slice(0, 16)}… window ${card.windowMs}ms`);
          let h = seedHash(card.uid, card.data);
          const frames: Uint8Array[] = [];
          const done = new Promise<void>((res, rej) => {
            const to = setTimeout(() => rej(new Error('camera delivered ' + frames.length + '/' + N_FRAMES + ' frames')), 3000);
            sink.current = (px, i, w, hh, f) => {
              if (i !== frames.length) return; // ordering guard
              frames.push(px); h = step(h, i, px); meta = { w, h: hh, f };
              if ((i + 1) % 5 === 0 || i + 1 === N_FRAMES) setProgress((k + (i + 1) / N_FRAMES) / maxSeg);
              if (frames.length === N_FRAMES) { clearTimeout(to); res(); }
            };
          });
          fIdx.value = 0; fT0.value = t0; capturing.value = true;
          try { await done; } finally { capturing.value = false; sink.current = null; }
          { const dt = Date.now() - t0; tl.push(`T=${Date.now() - T} seg ${k + 1}: ${N_FRAMES} frames chained (${meta.w}×${meta.h} ${meta.f}, ~${(N_FRAMES * 1000 / dt).toFixed(1)} fps)`); }
          const okP = waitEvent((e) => e.type === 'ok' || e.type === 'fail', 3000);
          await hsm.sendDigest(h);
          const r = await okP;
          if (r.type === 'fail') throw new Error('HSM rejected burn: ' + r.why);
          if (r.type !== 'ok') throw new Error('unexpected event');
          tl.push(`T=${Date.now() - T} seg ${k + 1}: digest ${hex(h).slice(0, 16)}… burned+readback @${r.tTotal}ms`);
          segs.push({ seed: card.data, digest: h, n: frames.length }); all.push(...frames); lastTotal = r.tTotal;
        } catch (e: any) {
          if (k === 0) throw e;
          // card still holds the last good segment's digest (a failed write can corrupt it — verify will tell)
          tl.push(`T=${Date.now() - T} seg ${k + 1}: ${e.message} — keeping ${k} segment(s)`);
          break;
        }
      }
      let thumb: string | null = null;
      try {
        const snap = await camera.current?.takeSnapshot({ quality: 70 });
        if (snap) thumb = keepThumb(snap.path, `thumbA-${Date.now()}.jpg`);
      } catch (e: any) { log('snapshot failed: ' + e.message); }
      const final = segs[segs.length - 1].digest;
      const clip: Clip = { label: 'on-site ' + new Date().toLocaleTimeString(), uid: uid!, seed: segs[0].seed, digest: final,
        w: meta.w, h: meta.h, pixelFormat: meta.f, frames: all, timeline: tl, thumb, segments: segs };
      setClip('A', clip); setTimeline(tl); tl.forEach(log); setProgress(1);
      setCapBanner({ cls: 'ok', text: `✅ ${segs.length} segment(s) · ${all.length} frames · ${((Date.now() - T) / 1000).toFixed(1)} s — chain burned to S50` });
      api.postEvent({ kind: 'burn', uid: hex(uid!), ms: lastTotal, result: 'pass', detail: tl.join(' | ') });
      api.postClip({ label: clip.label, uid: hex(clip.uid), seed: hex(clip.seed), digest: hex(final), w: clip.w, h: clip.h, n: all.length, timeline: tl })
        .then((res) => { if (res) { log('registered clip ' + res.id); setAnchor(res.anchor); } else log('backend offline — clip kept locally'); });
    } catch (e: any) {
      tl.forEach(log); log('capture failed: ' + e.message);
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
      const frames = perturb(A.frames, A.w);
      if (!useApi || thumb === A.thumb) {
        // show the twin's own (visibly synthetic) frame instead of reusing A's snapshot
        if (A.pixelFormat === 'y8' && frames[0]?.length === A.w * A.h) {
          const f = new File(Paths.document, 'clips', `thumbB-${Date.now()}.png`);
          f.write(new Uint8Array(Buffer.from(pngBase64(frames[0], A.w, A.h), 'base64')));
          thumb = f.uri;
        }
      }
      // twin claims A's provenance: same uid, seed, segments and claimed digest
      setClip('B', { ...A, label, frames, thumb, timeline: [] });
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
      const t = Date.now(); const { h, broken } = chainSegments(c.uid, c.segments, c.frames); const dt = Date.now() - t;
      const uidOk = eq(card.uid, c.uid), hashOk = broken < 0 && eq(card.data, h), pass = uidOk && hashOk;
      setVerInfo(`card uid ${hex(card.uid)} ${uidOk ? '=' : '≠'} clip uid ${hex(c.uid)}\n${c.segments.length} segment(s), ${c.frames.length} frames${broken >= 0 ? ` — chain breaks after segment ${broken}` : ''}\ncard Sector1 B4–5 ${hex(card.data)}\nrecomputed chain  ${hex(h)} (${dt} ms)`);
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
        <Text style={s.hex}>{c ? `${c.label}\nuid ${hex(c.uid)} · ${c.segments.length}seg ${c.frames.length}f ${c.w}×${c.h} ${c.pixelFormat}\nclaimed ${c.digest ? hex(c.digest).slice(0, 24) + '…' : '—'}` : 'empty'}</Text>
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
        {(['link', 'capture', 'arena', 'verify'] as Tab[]).map((t) => (
          <Pressable key={t} onPress={() => setTab(t)} style={[s.tab, tab === t && { borderBottomColor: C.acc }]}>
            <Text style={[s.tabT, tab === t && { color: C.fg }]}>{t}</Text>
          </Pressable>
        ))}
      </View>

      {/* keep Camera mounted across tabs (remounting the native view breaks the preview); hide + isActive=false instead */}
      <View style={[s.sec, tab !== 'capture' && s.offscreen]} pointerEvents={tab === 'capture' ? 'auto' : 'none'}>
          {device && hasPermission ? (
            camEl
          ) : <Text style={s.mut}>{hasPermission ? 'no camera device' : 'camera permission required'}</Text>}
          <View style={s.row}>
            <Btn title="Arm capture → tap card" disabled={!hsm || !device || busy} onPress={capture} />
            <Btn title={'segments: ' + maxSeg} sec disabled={busy} onPress={() => setMaxSeg(maxSeg >= 8 ? 1 : maxSeg * 2)} />
            <Btn title={'pixel: ' + pf} sec onPress={() => setPf(pf === 'rgb' ? 'yuv' : 'rgb')} />
          </View>
          <View style={s.bar}><View style={[s.barFill, { width: `${progress * 100}%` }]} /></View>
          <BannerV b={capBanner} />
          {anchor && <Text style={[s.hex, { color: C.acc }]} onPress={() => Linking.openURL(anchor.explorer)}>Solana anchor {anchor.signature.slice(0, 16)}… ↗</Text>}
      </View>

      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 12 }}>
        {tab === 'link' && (
          <View style={s.sec}>
            <Text style={s.h2}>HSM link</Text>
            <View style={s.row}>
              <Btn title="Connect VeriCam-HSM (BLE)" disabled={busy} onPress={() => link(new BleHsm(onBleDisconnect))} />
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
            <ComparePlayer A={clips.A} B={clips.B} />
            <View style={{ flexDirection: 'row', gap: 8 }}><ClipCard k="A" /><ClipCard k="B" /></View>
            <View style={s.row}>
              <Btn title="Generate UGC twin" sec disabled={!clips.A || busy} onPress={() => makeTwin(false)} />
              <Btn title="Twin via API (Gemini)" sec disabled={!clips.A || busy} onPress={() => makeTwin(true)} />
            </View>
            <Text style={s.mut}>Twin = A's frames resynthesized (banding, grain, smear) — visibly synthetic; it claims A's uid/seed/digest.</Text>
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
  offscreen: { position: 'absolute', left: -10000, top: 0, width: 320, opacity: 0 },
  bar: { height: 6, backgroundColor: C.line, borderRadius: 3, overflow: 'hidden', marginTop: 6 },
  barFill: { height: '100%', backgroundColor: C.acc },
  banner: { borderWidth: 2, borderRadius: 10, padding: 18, marginTop: 8, alignItems: 'center' },
  bannerT: { fontSize: 20, fontWeight: '800', textAlign: 'center' },
  clip: { flex: 1, borderWidth: 2, borderColor: C.line, borderRadius: 10, padding: 6 },
  thumb: { width: '100%', aspectRatio: 4 / 3, borderRadius: 6, marginVertical: 4 },
  vid: { width: '100%', aspectRatio: 3 / 4, maxHeight: 560, backgroundColor: '#000', borderRadius: 14, borderWidth: 3, overflow: 'hidden', marginVertical: 6 },
  vidImg: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
  vidTag: { position: 'absolute', top: 10, left: 10, color: '#000', fontWeight: '900', fontSize: 20, paddingHorizontal: 10, paddingVertical: 4, borderRadius: 8, overflow: 'hidden' },
  vidPlay: { position: 'absolute', alignSelf: 'center', top: '40%', color: '#fff', fontSize: 72, opacity: 0.85 },
  vidCap: { position: 'absolute', bottom: 10, left: 10, color: '#fff', fontWeight: '800', fontSize: 16, textShadowColor: '#000', textShadowRadius: 4 },
  bold: { color: C.fg, fontWeight: '700' },
  mut: { color: C.mut, fontSize: 13, marginTop: 4 },
  hex: { color: C.mut, fontFamily: Platform.select({ ios: 'Menlo', default: 'monospace' }), fontSize: 11, marginTop: 4 },
});
