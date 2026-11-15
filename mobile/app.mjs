import {SERVICE,COMMAND,STATE,WIDTH,HEIGHT,COUNT,hex,unhex,initial,step,parseState,verifyEvidence} from './core.mjs';
const $ = id => document.getElementById(id);
let device, command, state, stream, evidence, busy=false, downloadURL, twinURL;
const errors = {128:'RC522 not detected. Check wiring.',129:'Use a MIFARE Classic S50 / 1K card.',130:'Card authentication/read failed (factory Key A required).',131:'1,100 ms commitment deadline exceeded.',132:'No card detected within 15 seconds.',133:'Invalid commitment packet order.',134:'Card write/readback failed. Blocks may be partially changed.',135:'Card was written, but finished outside 1,100 ms. Timing proof failed.'};
const sleep = ms => new Promise(r=>setTimeout(r,ms));
function status(text) { $('status').textContent = text; }
function controls() {
  const connected=!!device?.gatt.connected;
  for(const id of ['connect','camera','evidence','twinFile','hook']) $(id).disabled=busy;
  $('capture').disabled=busy||!connected||!stream;
  $('verify').disabled=busy||!connected||!evidence;
  $('compare').disabled=busy||!connected||!evidence||!$('twin').src;
  $('generate').disabled=busy||!evidence;
  $('play').disabled=busy||!evidence;
}
function action(id, fn) { $(id).onclick=async()=>{busy=true;controls();try{await fn();}catch(e){status(e.message);}finally{busy=false;controls();}}; }
async function write(bytes) { if(!device?.gatt.connected) throw Error('ESP32 disconnected'); await command.writeValueWithResponse(bytes); }
async function wait(session, wanted, timeout=16000) {
  const start=performance.now();
  while(performance.now()-start<timeout) {
    const s=parseState(await state.readValue());
    if(s.session===hex(session)) {
      if(s.status>=128) throw Error(errors[s.status]||`Firmware error ${s.status}`);
      if(s.status===wanted) return s;
    }
    await sleep(15);
  }
  throw Error('ESP32 response timed out');
}
async function begin(op) {
  const session=crypto.getRandomValues(new Uint8Array(4));
  await write(Uint8Array.of(op.charCodeAt(0),...session));
  status('Hold the S50 card against the reader…');
  return {session,card:await wait(session,op==='B'?2:4)};
}
action('connect',async()=>{
  if(!isSecureContext) throw Error('Open this app over HTTPS (localhost is allowed for development).');
  if(!navigator.bluetooth) throw Error('This browser does not expose Web Bluetooth. Use Chrome Android or a compatible iOS browser.');
  device?.gatt.disconnect();
  device=await navigator.bluetooth.requestDevice({filters:[{services:[SERVICE]}]});
  device.addEventListener('gattserverdisconnected',()=>{status('ESP32 disconnected. Reconnect to continue.');controls();});
  const server=await device.gatt.connect(), service=await server.getPrimaryService(SERVICE);
  command=await service.getCharacteristic(COMMAND);state=await service.getCharacteristic(STATE);
  parseState(await state.readValue());status('Connected to VeriCam-HSM.');
});
action('camera',async()=>{
  if(!navigator.mediaDevices?.getUserMedia) throw Error('Camera unavailable; HTTPS and camera permission are required.');
  stream?.getTracks().forEach(t=>t.stop());
  stream=await navigator.mediaDevices.getUserMedia({video:{facingMode:{ideal:'environment'},width:{ideal:640},height:{ideal:480},frameRate:{ideal:30}},audio:false});
  $('live').srcObject=stream;await $('live').play();status('Camera ready.');
});
function nextFrame(video) {
  if(!video.requestVideoFrameCallback) throw Error('Browser must support requestVideoFrameCallback for distinct frames.');
  return new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{video.cancelVideoFrameCallback(handle);reject(Error('No new camera/video frame'));},1500);
    const handle=video.requestVideoFrameCallback((_,metadata)=>{clearTimeout(timer);resolve(metadata);});
  });
}
async function collect(video, uid, seed) {
  const canvas=document.createElement('canvas');canvas.width=WIDTH;canvas.height=HEIGHT;
  const context=canvas.getContext('2d',{willReadFrequently:true});
  let hash=await initial(unhex(uid),unhex(seed));const frames=[],times=[];
  for(let i=0;i<COUNT;i++) {
    const metadata=await nextFrame(video);
    context.drawImage(video,0,0,WIDTH,HEIGHT);
    const pixels=new Uint8Array(context.getImageData(0,0,WIDTH,HEIGHT).data);
    frames.push(pixels);times.push(metadata.mediaTime);
    hash=await step(hash,pixels,i);
  }
  return {hash,frames,times};
}
function base64(bytes) {
  let text='';for(let i=0;i<bytes.length;i+=8192) text+=String.fromCharCode(...bytes.subarray(i,i+8192));
  return btoa(text);
}
function saveEvidence(e) {
  evidence=e;if(downloadURL) URL.revokeObjectURL(downloadURL);
  downloadURL=URL.createObjectURL(new Blob([JSON.stringify(e)],{type:'application/json'}));
  $('download').href=downloadURL;$('download').download='vericam-evidence.json';$('download').hidden=false;
}
action('capture',async()=>{
  const {session,card}=await begin('B');
  try {
    const result=await collect($('live'),card.uid,hex(card.bytes));
    for(let offset=0;offset<32;offset+=14) {
      const packet=new Uint8Array(20);packet[0]=67;packet.set(session,1);packet[5]=offset;packet.set(result.hash.subarray(offset,offset+14),6);await write(packet);
    }
    const committed=await wait(session,3,3000);
    if(hex(committed.bytes)!==hex(result.hash)) throw Error('Commit acknowledgement digest mismatch');
    saveEvidence({format:'vericam-rgba-v1',width:WIDTH,height:HEIGHT,uid:card.uid,seed:hex(card.bytes),digest:hex(result.hash),elapsedMs:committed.elapsed,times:result.times,frames:result.frames.map(base64)});
    status(`COMMITTED & READ BACK · ${committed.elapsed} ms\n${hex(result.hash)}\nDownload the evidence to keep it.`);
  } finally { if(device?.gatt.connected) await write(Uint8Array.of(88,...session)).catch(()=>{}); }
});
$('evidence').onchange=async()=>{
  busy=true;controls();try{const file=$('evidence').files[0];if(!file)return;if(file.size>3000000)throw Error('Evidence file exceeds 3 MB');const e=JSON.parse(await file.text());await verifyEvidence(e);saveEvidence(e);status('Evidence loaded; tap Verify to compare with physical card.');}catch(e){status(e.message);}finally{busy=false;controls();}
};
async function compareHash(hash, uid) {
  const {card}=await begin('R');
  status(card.uid===uid && hex(card.bytes)===hex(hash)?'PASS · HARDWARE BYTE MATCH':'FAIL · CARD UID OR FRAME HASH MISMATCH');
}
action('verify',async()=>compareHash(await verifyEvidence(evidence),evidence.uid));
action('play',async()=>{
  const ctx=$('replay').getContext('2d');
  for(const frame of evidence.frames){const bytes=Uint8ClampedArray.from(atob(frame),c=>c.charCodeAt(0));ctx.putImageData(new ImageData(bytes,WIDTH,HEIGHT),0,0);await sleep(33);}
});
function loadTwin(blob) {if(twinURL)URL.revokeObjectURL(twinURL);twinURL=URL.createObjectURL(blob);$('twin').src=twinURL;controls();}
$('twinFile').onchange=()=>{if($('twinFile').files[0])loadTwin($('twinFile').files[0]);};
action('compare',async()=>{
  const video=$('twin');video.currentTime=0;video.muted=true;await video.play();
  try{const {hash}=await collect(video,evidence.uid,evidence.seed);video.pause();await compareHash(hash,evidence.uid);}finally{video.pause();}
});
action('generate',async()=>{
  const path=$('hook').value.trim();if(!path)throw Error('Enter your generation endpoint path.');
  const url=new URL(path,location.href);if(url.origin!==location.origin)throw Error('Generation hook must be same-origin.');
  status('Generating comparison video…');
  const response=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(evidence),signal:AbortSignal.timeout(120000)});
  if(!response.ok)throw Error(`Generation hook returned ${response.status}`);
  if(!response.headers.get('content-type')?.startsWith('video/'))throw Error('Generation hook must return a video/* response.');
  loadTwin(await response.blob());status('Comparison video ready.');
});
controls();
