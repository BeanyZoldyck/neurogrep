import { createStoreFromEnv, normalizePrefix } from './s3store.js';
import { initProofs } from './proofs.js';
import { createShare } from './share.js';

export async function openShareFromEnv(env = process.env) {
  const store = createStoreFromEnv(env);
  const proofs = await initProofs(env);
  const sweepLimit = Number(env.SHARE_SWEEP_LIMIT);
  const share = createShare({
    store,
    proofs,
    uploadKey: typeof env.VERICAM_UPLOAD_KEY === 'string' ? env.VERICAM_UPLOAD_KEY.trim() : '',
    prefix: normalizePrefix(env.SHARE_KEY_PREFIX),
    sweepLimit: Number.isFinite(sweepLimit) && sweepLimit > 0 ? sweepLimit : 500,
  });
  const every = Number(env.SHARE_SWEEP_INTERVAL_MS);
  return {
    store,
    proofs,
    share,
    sweepIntervalMs: Number.isFinite(every) && every >= 10000 ? every : 0,
  };
}

export function scheduleSweep(share, intervalMs) {
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    share.sweep()
      .then((summary) => {
        console.error(`[share] sweep checked=${summary.checked} genuine=${summary.genuine} tampered=${summary.tampered} unknown=${summary.unknown} listed=${summary.listedWithCredentials}`);
      })
      .catch((e) => console.error('[share] sweep failed:', e.message))
      .finally(() => { running = false; });
  }, intervalMs);
  timer.unref?.();
  return timer;
}
