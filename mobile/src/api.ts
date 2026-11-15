// Backend client (server/). Every call fails soft: returns null on any error / timeout.
import Constants from 'expo-constants';

export const DEFAULT_API: string = (Constants.expoConfig?.extra as any)?.apiBase || 'https://vericam.example.com';
let base = DEFAULT_API;
export const setApiBase = (b: string) => { base = b.trim().replace(/\/+$/, ''); };
export const getApiBase = () => base;

async function call<T>(method: 'GET' | 'POST', path: string, body?: unknown, ms = 8000): Promise<T | null> {
  if (!base) return null;
  const ac = new AbortController(); const t = setTimeout(() => ac.abort(), ms);
  try {
    const r = await fetch(base + path, {
      method, signal: ac.signal,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!r.ok) return null;
    return (await r.json()) as T;
  } catch { return null; } finally { clearTimeout(t); }
}

export type Anchor = { signature: string; explorer: string } | null;
export const postClip = (c: { label: string; uid: string; seed: string; digest: string; w: number; h: number; n: number; timeline: string[] }) =>
  call<{ id: string; anchor: Anchor }>('POST', '/api/clips', { ...c, source: 'mobile' }, 15000);

export function postEvent(e: { kind: 'capture' | 'burn' | 'verify' | 'fail'; uid: string; ms: number; result: 'pass' | 'fail' | null; detail: string }) {
  void call('POST', '/api/events', e, 5000);
}
export const explain = (b: { result: 'pass' | 'fail'; uidOk: boolean; hashOk: boolean; cardHex: string; chainHex: string; label: string }) =>
  call<{ text: string }>('POST', '/api/explain', b, 15000);
export const twin = (b: { width: number; height: number; frames: string[] }) =>
  call<{ frames: string[] }>('POST', '/api/twin', b, 30000);
