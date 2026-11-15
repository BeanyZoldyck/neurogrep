import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { computeProof } from './evidence.js';
import { HttpError } from './errors.js';
import { assertObjectKey, keyFromPublicUrl, normalizePrefix } from './s3store.js';

function keysMatch(provided, expected) {
  if (typeof expected !== 'string' || expected.length === 0) return false;
  if (typeof provided !== 'string' || provided.length === 0 || provided.length > 256) return false;
  const a = createHash('sha256').update(expected).digest();
  const b = createHash('sha256').update(provided).digest();
  return timingSafeEqual(a, b);
}

function cleanLabel(value) {
  if (value == null) return null;
  const text = String(value).trim();
  return text ? text.slice(0, 200) : null;
}

function unwrap(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'JSON object required');
  if (body.format === 'vericam-rgba-v1') return { evidence: body, label: body.label };
  if (body.evidence && typeof body.evidence === 'object' && body.evidence.format === 'vericam-rgba-v1') {
    return { evidence: body.evidence, label: body.label ?? body.evidence.label };
  }
  throw new HttpError(400, 'body must be vericam-rgba-v1 evidence');
}

function firstMismatch(got, expected) {
  const a = Array.isArray(got) ? got : [];
  const b = Array.isArray(expected) ? expected : [];
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i;
  return null;
}

function judge({ record, payloadSha256, digest, frameHashes, parseError, fetchError, recordsKind }) {
  if (fetchError?.code === 'NotFound') {
    if (!record) {
      const reason = recordsKind === 'disabled'
        ? 'no public object and Tiger Data is not configured'
        : 'no public object and no verification record';
      return { verdict: 'unknown', reason, firstDivergentFrame: null, digest: null };
    }
    return {
      verdict: 'tampered',
      reason: `verification record exists but the public object is unavailable (HTTP ${fetchError.status})`,
      firstDivergentFrame: null,
      digest: null,
    };
  }
  if (!record) {
    const why = recordsKind === 'disabled' ? 'Tiger Data is not configured' : 'no verification record';
    const extra = parseError ? ` (${parseError.message})` : '';
    return { verdict: 'unknown', reason: `${why}${extra}`, firstDivergentFrame: null, digest: digest ?? null };
  }
  if (parseError || !frameHashes) {
    return {
      verdict: 'tampered',
      reason: `object is no longer valid evidence (${parseError?.message || 'unreadable'})`,
      firstDivergentFrame: null,
      digest: null,
    };
  }
  const mismatch = firstMismatch(frameHashes, record.frame_hashes);
  const payloadOk = payloadSha256 === record.payload_sha256;
  const chainOk = digest === record.digest && mismatch == null;
  if (payloadOk && chainOk) {
    return { verdict: 'genuine', reason: 'public object matches the verification record', firstDivergentFrame: null, digest };
  }
  const reasons = [];
  if (!payloadOk) reasons.push('object bytes do not match the published payload hash');
  if (!chainOk) reasons.push('frame chain does not match the published record');
  return { verdict: 'tampered', reason: reasons.join('; '), firstDivergentFrame: mismatch, digest };
}

export function createShare({ store, proofs, uploadKey = '', prefix = 'videos/', sweepLimit = 500, id } = {}) {
  const keyPrefix = normalizePrefix(prefix);
  const limit = Math.max(1, Math.min(Number(sweepLimit) || 500, 5000));
  const newId = id || (() => randomUUID());

  function assertOperator(presented) {
    if (!uploadKey) throw new HttpError(503, 'VERICAM_UPLOAD_KEY is not set');
    if (!keysMatch(presented, uploadKey)) throw new HttpError(401, 'unauthorized');
  }

  async function complete(partial) {
    const judged = judge({ ...partial, recordsKind: proofs.kind });
    const body = {
      verdict: judged.verdict,
      reason: judged.reason,
      fetch: store.transport,
      records: proofs.kind,
      videoId: partial.record?.video_id ?? null,
      key: partial.key ?? partial.record?.object_key ?? null,
      url: partial.url ?? partial.record?.public_url ?? null,
      digest: judged.digest ?? null,
      recordedDigest: partial.record?.digest ?? null,
      payloadSha256: partial.payloadSha256 ?? null,
      recordedPayloadSha256: partial.record?.payload_sha256 ?? null,
      firstDivergentFrame: judged.firstDivergentFrame ?? null,
      uid: partial.uid ?? partial.record?.uid ?? null,
    };
    if (typeof judged.firstDivergentFrame === 'number' && partial.frameHashes) {
      body.frameHash = partial.frameHashes[judged.firstDivergentFrame] ?? null;
      body.recordedFrameHash = partial.record?.frame_hashes?.[judged.firstDivergentFrame] ?? null;
    }
    try {
      await proofs.recordCheck({
        object_key: body.key || '',
        public_url: body.url || '',
        video_id: body.videoId,
        verdict: body.verdict,
        reason: body.reason,
        digest: body.digest,
        recorded_digest: body.recordedDigest,
        first_divergent_frame: body.firstDivergentFrame,
      });
    } catch (e) {
      console.error('[proofs] check log failed:', e.message);
    }
    return body;
  }

  async function publish({ body, auth }) {
    assertOperator(auth);
    if (!store.canWrite) {
      throw new HttpError(503, 'S3 write credentials are not set. Set S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY. Public verify does not need them.');
    }
    if (!proofs.enabled) throw new HttpError(503, 'TIGER_DATABASE_URL (or DATABASE_URL) is not set');
    const { evidence, label } = unwrap(body);
    let proof;
    try {
      proof = await computeProof(evidence);
    } catch (e) {
      throw new HttpError(400, e.message);
    }
    const videoId = newId();
    const key = `${keyPrefix}${videoId}.json`;
    const bytes = Buffer.from(JSON.stringify(evidence));
    const payloadSha256 = createHash('sha256').update(bytes).digest('hex');
    const url = await store.put(key, bytes);
    try {
      await proofs.insert({
        video_id: videoId,
        object_key: key,
        public_url: url,
        uid: proof.uid,
        seed: proof.seed,
        digest: proof.digest,
        payload_sha256: payloadSha256,
        width: proof.width,
        height: proof.height,
        frame_count: proof.frameCount,
        frame_hashes: proof.frameHashes,
        verdict: 'genuine',
        label: cleanLabel(label),
      });
    } catch (e) {
      if (e instanceof HttpError) throw e;
      throw new HttpError(502, `saved the public object but failed to write the Tiger Data record: ${e.message}`);
    }
    return {
      videoId, key, url, digest: proof.digest, payloadSha256, verdict: 'genuine', uid: proof.uid,
      label: cleanLabel(label),
    };
  }

  async function check({ key, url } = {}) {
    const givenKey = typeof key === 'string' ? key.trim() : '';
    const givenUrl = typeof url === 'string' ? url.trim() : '';
    if (!givenKey && !givenUrl) throw new HttpError(400, 'key or url is required');
    if (givenKey) assertObjectKey(givenKey);
    if (givenUrl && !store.isPublicUrl(givenUrl)) throw new HttpError(400, 'url is outside the public bucket');
    if (givenKey && givenUrl && keyFromPublicUrl(givenUrl, store.publicBaseUrl) !== givenKey) {
      throw new HttpError(400, 'key does not match url');
    }
    const resolvedKey = givenKey || keyFromPublicUrl(givenUrl, store.publicBaseUrl);
    if (!resolvedKey) throw new HttpError(400, 'invalid object key');
    assertObjectKey(resolvedKey);
    const resolvedUrl = givenUrl || store.publicUrl(resolvedKey);
    if (!store.isPublicUrl(resolvedUrl)) throw new HttpError(400, 'url is outside the public bucket');

    let record = null;
    if (proofs.kind !== 'disabled') {
      record = await proofs.latestByKey(resolvedKey) || await proofs.latestByUrl(resolvedUrl);
    }

    let bytes;
    try {
      bytes = await store.fetchPublic(resolvedUrl);
    } catch (e) {
      if (e.code === 'NotFound') {
        return complete({ record, key: resolvedKey, url: resolvedUrl, fetchError: e, uid: record?.uid ?? null });
      }
      if (e instanceof HttpError) throw e;
      throw new HttpError(502, e.message || 'public fetch failed');
    }

    const payloadSha256 = createHash('sha256').update(bytes).digest('hex');
    let proof = null;
    let parseError = null;
    try {
      proof = await computeProof(JSON.parse(bytes.toString('utf8')));
    } catch (e) {
      parseError = e;
    }
    return complete({
      record,
      key: resolvedKey,
      url: resolvedUrl,
      payloadSha256,
      digest: proof?.digest ?? null,
      frameHashes: proof?.frameHashes ?? null,
      parseError,
      uid: proof?.uid ?? record?.uid ?? null,
    });
  }

  async function sweep() {
    if (proofs.kind === 'error') throw new HttpError(503, proofs.error || 'Tiger Data is unavailable');
    if (!proofs.enabled && !store.canList) {
      throw new HttpError(503, 'Sweep needs Tiger Data records or S3 credentials. Public listing is disabled.');
    }
    const recent = proofs.enabled ? await proofs.listRecent(limit) : [];
    const keys = new Set();
    for (const row of recent) if (row.object_key) keys.add(row.object_key);
    let listError = null;
    if (store.canList) {
      try {
        for (const key of await store.list(keyPrefix, limit)) keys.add(key);
      } catch (e) {
        listError = e.message || String(e);
        console.error('[share] authenticated list failed; checking Tiger Data keys only:', listError);
      }
    }
    const results = [];
    for (const key of [...keys].sort()) {
      try {
        results.push(await check({ key }));
      } catch (e) {
        results.push({
          verdict: 'unknown',
          reason: e.message || 'check failed',
          fetch: store.transport,
          records: proofs.kind,
          videoId: null,
          key,
          url: null,
          digest: null,
          recordedDigest: null,
          payloadSha256: null,
          recordedPayloadSha256: null,
          firstDivergentFrame: null,
          uid: null,
        });
      }
    }
    const count = (name) => results.filter((row) => row.verdict === name).length;
    return {
      fetch: store.transport,
      listedWithCredentials: !!store.canList,
      listError,
      checked: results.length,
      genuine: count('genuine'),
      tampered: count('tampered'),
      unknown: count('unknown'),
      results,
    };
  }

  return { publish, check, sweep, assertOperator, store, proofs, prefix: keyPrefix };
}
