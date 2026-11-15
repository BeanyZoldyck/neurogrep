import { openShareFromEnv } from '../lib/runtime.js';

function flag(name) {
  const i = process.argv.indexOf(name);
  return i === -1 ? '' : (process.argv[i + 1] || '');
}

const key = flag('--key');
const url = flag('--url');
if (!key && !url) {
  console.error('usage: npm run share:verify -- --key <object-key> | --url <public-url>');
  process.exit(3);
}

const { proofs, share } = await openShareFromEnv();
let code = 0;
try {
  const out = await share.check({ key, url });
  console.error(`${out.verdict}: ${out.reason}`);
  console.log(JSON.stringify(out, null, 2));
  code = out.verdict === 'genuine' ? 0 : out.verdict === 'tampered' ? 2 : 1;
} catch (e) {
  console.error(e.message);
  code = 3;
} finally {
  await proofs.close?.();
}
process.exit(code);
