import { GoogleGenAI } from '@google/genai';

const KEY = process.env.GEMINI_API_KEY;
const IMAGE_MODEL = process.env.GEMINI_IMAGE_MODEL || 'gemini-2.5-flash-image';
const TEXT_MODEL = process.env.GEMINI_TEXT_MODEL || 'gemini-2.5-flash';
const ai = KEY ? new GoogleGenAI({ apiKey: KEY }) : null;
if (!ai) console.log('[gemini] GEMINI_API_KEY not set; /api/twin -> 503, /api/explain -> template');

export const enabled = () => !!ai;

const PROMPT = 'Regenerate this image as a photorealistic, visually identical copy. Keep the exact same framing, ' +
  'composition, subjects, lighting, colors and resolution. Output only the image.';

async function twinFrame(dataUrl) {
  const m = /^data:([^;]+);base64,(.+)$/.exec(dataUrl || '');
  if (!m) return dataUrl;
  try {
    const r = await ai.models.generateContent({
      model: IMAGE_MODEL,
      contents: [{ role: 'user', parts: [{ inlineData: { mimeType: m[1], data: m[2] } }, { text: PROMPT }] }],
    });
    const img = r.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data);
    return img ? `data:${img.inlineData.mimeType || 'image/png'};base64,${img.inlineData.data}` : dataUrl;
  } catch (e) {
    console.error('[gemini] twin frame failed:', e.message);
    return dataUrl;
  }
}

export async function twin(frames, concurrency = 5) {
  const out = new Array(frames.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, frames.length) }, async () => {
    while (next < frames.length) { const i = next++; out[i] = await twinFrame(frames[i]); }
  }));
  return { frames: out, model: IMAGE_MODEL };
}

const short = (h) => (h ? String(h).slice(0, 16) + '…' : 'n/a');

function template({ result, uidOk, hashOk, cardHex, chainHex, label }) {
  const name = label ? `"${label}"` : 'This clip';
  if (result === 'pass')
    return `${name} is hardware verified: the card UID matched and the recomputed SHA-256 frame chain (${short(chainHex)}) ` +
      `equals the digest burned into the card's EEPROM (${short(cardHex)}). Any changed pixel in any frame would have broken the chain.`;
  const why = [!uidOk && 'the card UID does not match the capture', !hashOk && `the recomputed frame chain (${short(chainHex)}) diverges from the burned digest (${short(cardHex)})`]
    .filter(Boolean).join(' and ') || 'the verification check did not pass';
  return `${name} was rejected because ${why}. The digest was written to the card during a ~1.1 s RF window at capture time, ` +
    `so a synthetic or regenerated twin produced afterwards cannot reproduce it.`;
}

export async function explain(body) {
  if (!ai) return template(body);
  try {
    const r = await ai.models.generateContent({
      model: TEXT_MODEL,
      contents: `You explain a hardware-anchored video authenticity check to hackathon judges in 2-3 plain sentences, no markdown.
System: an NFC card's EEPROM state seeds a rolling SHA-256 chain over 25 raw camera frames; the final digest is burned onto the card within ~1.1 s. Verification recomputes the chain from the video and compares it to the card.
Result: ${JSON.stringify({ result: body.result, uidOk: body.uidOk, hashOk: body.hashOk, cardDigest: body.cardHex, recomputedDigest: body.chainHex, label: body.label })}`,
    });
    return r.text?.trim() || template(body);
  } catch (e) {
    console.error('[gemini] explain failed:', e.message);
    return template(body);
  }
}
