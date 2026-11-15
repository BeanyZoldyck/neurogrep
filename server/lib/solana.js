import { Connection, Keypair, PublicKey, Transaction, TransactionInstruction, sendAndConfirmTransaction } from '@solana/web3.js';
import bs58 from 'bs58';

const MEMO = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');
const RPC = process.env.SOLANA_RPC || 'https://api.devnet.solana.com';
const CLUSTER = process.env.SOLANA_CLUSTER || 'devnet';

function loadKey() {
  const s = process.env.SOLANA_SECRET_KEY?.trim();
  if (!s) { console.log('[solana] SOLANA_SECRET_KEY not set; anchoring disabled'); return null; }
  try {
    const kp = Keypair.fromSecretKey(s.startsWith('[') ? Uint8Array.from(JSON.parse(s)) : bs58.decode(s));
    console.log('[solana] payer', kp.publicKey.toBase58(), 'on', RPC);
    return kp;
  } catch (e) { console.error('[solana] bad SOLANA_SECRET_KEY:', e.message); return null; }
}

const payer = loadKey();
const conn = payer ? new Connection(RPC, 'confirmed') : null;

export const enabled = () => !!payer;

export async function anchor(uid, digest) {
  if (!payer) return null;
  try {
    const ix = new TransactionInstruction({
      programId: MEMO,
      keys: [{ pubkey: payer.publicKey, isSigner: true, isWritable: false }],
      data: Buffer.from(`vericam:v1:${uid}:${digest}`, 'utf8'),
    });
    const signature = await sendAndConfirmTransaction(conn, new Transaction().add(ix), [payer]);
    const q = CLUSTER === 'mainnet-beta' ? '' : `?cluster=${CLUSTER}`;
    return { signature, explorer: `https://explorer.solana.com/tx/${signature}${q}` };
  } catch (e) {
    console.error('[solana] anchor failed:', e.message);
    return null;
  }
}
