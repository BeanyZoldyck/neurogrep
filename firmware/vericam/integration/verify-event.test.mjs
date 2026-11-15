import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {verifyEvent} from './verify-event.mjs';
test('authenticates exact device event bytes and rejects tampering or wrong key',()=>{
  const key='test-only-device-key-32-characters-long';
  const state=Buffer.alloc(54);state[0]=1;state[1]=3;state.writeUInt32LE(1000,8);
  const body=Buffer.from(JSON.stringify({version:1,device:'28562f710cf0',boot:'a'.repeat(32),sequence:1,state:state.toString('hex')}));
  const signature=createHmac('sha256',key).update(body).digest('hex');
  assert.equal(verifyEvent(body,signature,key).elapsedMs,1000);
  assert.throws(()=>verifyEvent(Buffer.concat([body,Buffer.from(' ')]),signature,key));
  assert.throws(()=>verifyEvent(body,signature,'incorrect-device-key-32-characters-long'));
  assert.throws(()=>verifyEvent(body,'bad',key));
});
