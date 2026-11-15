import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {verifyEvidence,parseState,hex} from './core.mjs';
test('preserved frames match independently computed chain; edits and reordered frames fail',async()=>{
  const frames=Array.from({length:25},(_,i)=>Buffer.alloc(160*120*4,i));
  const uid=Buffer.from('01020304','hex'),seed=Buffer.alloc(32,7);
  const hash=b=>createHash('sha256').update(b).digest();
  let expected=hash(Buffer.concat([Buffer.from('VeriCam-v1:160x120:25:RGBA'),Buffer.from([4]),uid,seed]));
  for(let i=0;i<25;i++)expected=hash(Buffer.concat([expected,Buffer.from([i]),frames[i]]));
  const e={format:'vericam-rgba-v1',width:160,height:120,uid:uid.toString('hex'),seed:seed.toString('hex'),frames:frames.map(f=>f.toString('base64'))};
  assert.equal(hex(await verifyEvidence(e)),expected.toString('hex'));
  [e.frames[0],e.frames[1]]=[e.frames[1],e.frames[0]];
  assert.notEqual(hex(await verifyEvidence(e)),expected.toString('hex'));
  e.frames[0]='bad';await assert.rejects(verifyEvidence(e));
});
test('state parsing respects DataView offsets and little-endian timing',()=>{
  const b=new Uint8Array(60),v=new DataView(b.buffer,3,54);v.setUint8(0,1);v.setUint8(1,3);v.setUint8(2,4);v.setUint32(8,1099,true);
  const s=parseState(v);assert.equal(s.elapsed,1099);assert.equal(s.status,3);assert.equal(s.uid,'00000000');
  assert.throws(()=>parseState(new DataView(new ArrayBuffer(20))));
});
