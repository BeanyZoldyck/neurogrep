import { writeFileSync } from 'node:fs';
import { makeEvidence } from '../lib/sample-evidence.js';

const out = process.argv[2];
if (!out) {
  console.error('usage: npm run share:sample -- <outfile.json>');
  process.exit(3);
}
writeFileSync(out, JSON.stringify(makeEvidence({ label: 'synthetic sample' })));
console.error(`wrote ${out}`);
