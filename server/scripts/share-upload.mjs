import { readFileSync } from 'node:fs';
import { openShareFromEnv } from '../lib/runtime.js';

const file = process.argv[2];
if (!file) {
  console.error('usage: npm run share:upload -- <evidence.json>');
  process.exit(3);
}

const { proofs, share } = await openShareFromEnv();
let code = 0;
try {
  const body = JSON.parse(readFileSync(file, 'utf8'));
  const out = await share.publish({ body, auth: process.env.VERICAM_UPLOAD_KEY?.trim() || '' });
  console.log(JSON.stringify(out, null, 2));
} catch (e) {
  console.error(e.message);
  code = e.status && e.status < 500 ? 3 : 1;
} finally {
  await proofs.close?.();
}
process.exit(code);
