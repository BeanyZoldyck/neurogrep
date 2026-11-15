import { MongoClient } from 'mongodb';

let coll = null;
const mem = [];

export const enabled = () => !!coll;

export async function init() {
  const uri = process.env.MONGODB_URI;
  if (!uri) return console.log('[mongo] MONGODB_URI not set; using in-memory clips');
  try {
    const client = new MongoClient(uri, { serverSelectionTimeoutMS: 8000 });
    await client.connect();
    coll = client.db('vericam').collection('clips');
    await coll.createIndex({ createdAt: -1 });
    console.log('[mongo] connected');
  } catch (e) {
    console.error('[mongo] connect failed, using in-memory:', e.message);
    coll = null;
  }
}

export async function insertClip(clip) {
  mem.unshift(clip);
  if (mem.length > 500) mem.length = 500;
  if (!coll) return;
  try { await coll.insertOne({ ...clip, _id: clip.id }); }
  catch (e) { console.error('[mongo] insert failed:', e.message); }
}

export async function latestClips(limit = 50) {
  if (coll) {
    try { return (await coll.find({}, { projection: { _id: 0 } }).sort({ createdAt: -1 }).limit(limit).toArray()); }
    catch (e) { console.error('[mongo] find failed:', e.message); }
  }
  return mem.slice(0, limit);
}
