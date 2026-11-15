import { openShareFromEnv } from '../lib/runtime.js';

if (!process.env.VERICAM_UPLOAD_KEY?.trim()) {
  console.error('VERICAM_UPLOAD_KEY is not set');
  process.exit(3);
}

const { proofs, share } = await openShareFromEnv();
let code = 0;
try {
  const summary = await share.sweep();
  console.error(`checked=${summary.checked} genuine=${summary.genuine} tampered=${summary.tampered} unknown=${summary.unknown} listed=${summary.listedWithCredentials}`);
  console.log(JSON.stringify(summary, null, 2));
  code = summary.tampered > 0 ? 2 : summary.unknown > 0 ? 1 : 0;
} catch (e) {
  console.error(e.message);
  code = 3;
} finally {
  await proofs.close?.();
}
process.exit(code);
