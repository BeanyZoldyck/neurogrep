import { Keypair } from '@solana/web3.js';
import { writeFileSync, existsSync } from 'node:fs';
const out = process.argv[2] || 'vericam.keypair.json';
if (existsSync(out)) { console.error(`${out} exists; refusing to overwrite`); process.exit(1); }
const kp = Keypair.generate();
writeFileSync(out, JSON.stringify(Array.from(kp.secretKey)), { mode: 0o600 });
console.log(`wrote ${out}\npubkey: ${kp.publicKey.toBase58()}`);
console.log(`\nFund it (devnet):\n  solana airdrop 1 ${kp.publicKey.toBase58()} --url devnet\n  or https://faucet.solana.com`);
console.log(`\nThen in .env:\n  SOLANA_SECRET_KEY='${JSON.stringify(Array.from(kp.secretKey))}'`);
