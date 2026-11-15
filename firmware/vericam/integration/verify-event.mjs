// Backend-side reference: never ship device keys to the React browser bundle.
import {createHmac, timingSafeEqual} from 'node:crypto';

export function verifyEvent(rawBody, signature, deviceKey) {
  if (!Buffer.isBuffer(rawBody) || rawBody.length > 1024) throw Error('Invalid event body');
  if (typeof signature !== 'string' || !/^[a-f0-9]{64}$/.test(signature)) throw Error('Invalid signature');
  if (typeof deviceKey !== 'string' || deviceKey.length < 32) throw Error('Missing device key');
  const expected = createHmac('sha256', deviceKey).update(rawBody).digest();
  if (!timingSafeEqual(expected, Buffer.from(signature, 'hex'))) throw Error('Authentication failed');
  const event = JSON.parse(rawBody.toString('utf8'));
  if (event.version !== 1 || !/^[a-f0-9]{12}$/.test(event.device) || !/^[a-f0-9]{32}$/.test(event.boot) ||
      !Number.isSafeInteger(event.sequence) || event.sequence < 1 || event.sequence > 0xffffffff ||
      !/^[a-f0-9]{108}$/.test(event.state)) throw Error('Invalid event schema');
  const state = Buffer.from(event.state, 'hex');
  if (state[0] !== 1 || ![3,4,128,129,130,131,132,133,134,135].includes(state[1])) throw Error('Invalid state');
  return {...event, status:state[1], session:state.subarray(4,8).toString('hex'), elapsedMs:state.readUInt32LE(8)};
}
