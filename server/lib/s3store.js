import { S3Client, PutObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { HttpError, PublicObjectError } from './errors.js';

export const DEFAULT_BUCKET = 'neurogrep-public-1794752476';
export const DEFAULT_REGION = 'us-east-1';
export const DEFAULT_PUBLIC_BASE_URL = 'https://neurogrep-public-1794752476.s3.amazonaws.com';
export const MAX_PUBLIC_BYTES = 8 * 1024 * 1024;

export function pick(value, fallback) {
  if (typeof value !== 'string' || value.trim() === '') return fallback;
  return value.trim();
}

// us-east-1 virtual-hosted URLs use the global host, with no region label.
export function defaultPublicBase({ bucket, region, endpoint }) {
  if (endpoint) return `${endpoint.replace(/\/+$/, '')}/${bucket}`;
  if (!region || region === 'us-east-1') return `https://${bucket}.s3.amazonaws.com`;
  return `https://${bucket}.s3.${region}.amazonaws.com`;
}

export function loadS3Config(env = process.env) {
  const bucket = pick(env.S3_BUCKET, DEFAULT_BUCKET);
  const region = pick(env.S3_REGION, DEFAULT_REGION);
  const endpoint = pick(env.S3_ENDPOINT, '');
  const derived = defaultPublicBase({ bucket, region, endpoint });
  const pathFlag = pick(env.S3_FORCE_PATH_STYLE, '');
  return {
    bucket,
    region,
    endpoint,
    publicBaseUrl: pick(env.S3_PUBLIC_BASE_URL, derived).replace(/\/+$/, ''),
    forcePathStyle: pathFlag === 'true' ? true : pathFlag === 'false' ? false : !!endpoint,
    accessKeyId: pick(env.S3_ACCESS_KEY_ID, ''),
    secretAccessKey: pick(env.S3_SECRET_ACCESS_KEY, ''),
    objectAcl: pick(env.S3_OBJECT_ACL, ''),
  };
}

export function publicObjectUrl(publicBaseUrl, key) {
  const base = publicBaseUrl.replace(/\/+$/, '');
  const encoded = key.split('/').map((part) => encodeURIComponent(part)).join('/');
  return `${base}/${encoded}`;
}

export function isUrlUnderBase(url, publicBaseUrl) {
  let actual;
  let base;
  try {
    actual = new URL(url);
    base = new URL(publicBaseUrl.endsWith('/') ? publicBaseUrl : `${publicBaseUrl}/`);
  } catch {
    return false;
  }
  if (actual.username || actual.password) return false;
  if (actual.origin !== base.origin) return false;
  const basePath = base.pathname.replace(/\/+$/, '');
  if (basePath === '') return actual.pathname.startsWith('/');
  return actual.pathname === basePath || actual.pathname.startsWith(`${basePath}/`);
}

export function keyFromPublicUrl(url, publicBaseUrl) {
  if (!isUrlUnderBase(url, publicBaseUrl)) return '';
  const actual = new URL(url);
  const base = new URL(publicBaseUrl.endsWith('/') ? publicBaseUrl : `${publicBaseUrl}/`);
  const basePath = base.pathname.replace(/\/+$/, '');
  let path = actual.pathname;
  if (basePath && path.startsWith(basePath)) path = path.slice(basePath.length);
  path = path.replace(/^\/+/, '');
  try {
    return path.split('/').map((part) => decodeURIComponent(part)).join('/');
  } catch {
    return '';
  }
}

export function assertObjectKey(key) {
  if (typeof key !== 'string' || key.length < 1 || key.length > 1024) throw new HttpError(400, 'invalid object key');
  if (key.startsWith('/') || key.includes('..') || key.includes('\\') || key.includes('//')) {
    throw new HttpError(400, 'invalid object key');
  }
  if (!/^[a-zA-Z0-9._/-]+$/.test(key)) throw new HttpError(400, 'invalid object key');
}

export function normalizePrefix(value) {
  const raw = pick(value, 'videos/').replace(/^\/+/, '');
  if (!raw || raw.includes('..') || raw.includes('\\') || !/^[a-zA-Z0-9._/-]+$/.test(raw)) {
    throw new HttpError(500, 'SHARE_KEY_PREFIX is invalid');
  }
  return raw.endsWith('/') ? raw : `${raw}/`;
}

function createClient(config) {
  return new S3Client({
    region: config.region,
    endpoint: config.endpoint || undefined,
    forcePathStyle: config.forcePathStyle,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
    // Default CRC32 checksums are rejected by some S3-compatible stores.
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumCalculation: 'WHEN_REQUIRED',
    maxAttempts: 3,
  });
}

async function readBody(res) {
  if (res.status === 403 || res.status === 404) {
    throw new PublicObjectError(res.status, `public object unavailable (HTTP ${res.status})`);
  }
  if (!res.ok) throw new PublicObjectError(res.status, `public fetch failed (HTTP ${res.status})`);
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_PUBLIC_BYTES) {
    throw new PublicObjectError(413, 'public object is too large');
  }
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.length > MAX_PUBLIC_BYTES) throw new PublicObjectError(413, 'public object is too large');
  return bytes;
}

const LIST_DENIED = 'S3 credentials are required to upload or list. Public listing is disabled; verify with a key or URL.';

export function createS3Store(config = loadS3Config({}), deps = {}) {
  const keyed = !!(config.accessKeyId && config.secretAccessKey);
  const canAuth = keyed || !!deps.client;
  let client = deps.client || null;
  const fetchImpl = deps.fetchImpl || globalThis.fetch;
  function sdk() {
    if (client) return client;
    if (!keyed) throw new HttpError(503, LIST_DENIED);
    client = createClient(config);
    return client;
  }
  return {
    kind: 's3',
    transport: 'public-https',
    bucket: config.bucket,
    publicBaseUrl: config.publicBaseUrl,
    canWrite: canAuth,
    canList: canAuth,
    publicUrl(key) {
      assertObjectKey(key);
      return publicObjectUrl(config.publicBaseUrl, key);
    },
    isPublicUrl(url) {
      return isUrlUnderBase(url, config.publicBaseUrl);
    },
    async put(key, body) {
      assertObjectKey(key);
      const input = {
        Bucket: config.bucket,
        Key: key,
        Body: body,
        ContentType: 'application/json; charset=utf-8',
        CacheControl: 'no-store',
      };
      if (config.objectAcl) input.ACL = config.objectAcl;
      try {
        await sdk().send(new PutObjectCommand(input));
      } catch (e) {
        if (e instanceof HttpError) throw e;
        throw new HttpError(502, `S3 upload failed: ${e.message || e.name || 'upload failed'}`);
      }
      return publicObjectUrl(config.publicBaseUrl, key);
    },
    async fetchPublic(url) {
      if (!isUrlUnderBase(url, config.publicBaseUrl)) throw new HttpError(400, 'url is outside the public bucket');
      let res;
      try {
        res = await fetchImpl(url, { redirect: 'error', signal: AbortSignal.timeout(20000) });
      } catch (e) {
        throw new PublicObjectError(502, `public fetch failed: ${e.message}`);
      }
      return readBody(res);
    },
    async list(prefix, limit = 500) {
      const keys = [];
      let token;
      const cap = Math.max(1, Math.min(limit, 5000));
      do {
        let out;
        try {
          out = await sdk().send(new ListObjectsV2Command({
            Bucket: config.bucket,
            Prefix: prefix || undefined,
            ContinuationToken: token,
            MaxKeys: Math.min(1000, cap - keys.length),
          }));
        } catch (e) {
          if (e instanceof HttpError) throw e;
          throw new HttpError(502, `S3 list failed: ${e.message || e.name || 'list failed'}`);
        }
        for (const obj of out.Contents || []) if (obj.Key) keys.push(obj.Key);
        token = out.IsTruncated ? out.NextContinuationToken : undefined;
      } while (token && keys.length < cap);
      return keys;
    },
  };
}

export function createStoreFromEnv(env = process.env) {
  const store = createS3Store(loadS3Config(env));
  console.error(`[s3] public ${store.publicBaseUrl} bucket=${store.bucket} write=${store.canWrite}`);
  return store;
}

export function createMemoryStore(publicBaseUrl = 'https://memory.invalid') {
  const base = publicBaseUrl.replace(/\/+$/, '');
  const objects = new Map();
  return {
    kind: 'memory',
    transport: 'memory',
    bucket: 'memory',
    publicBaseUrl: base,
    canWrite: true,
    canList: false,
    objects,
    publicUrl(key) {
      assertObjectKey(key);
      return publicObjectUrl(base, key);
    },
    isPublicUrl(url) {
      return isUrlUnderBase(url, base);
    },
    async put(key, body) {
      assertObjectKey(key);
      objects.set(key, Buffer.from(body));
      return publicObjectUrl(base, key);
    },
    async overwrite(key, body) {
      if (!objects.has(key)) throw new HttpError(404, 'missing object');
      objects.set(key, Buffer.from(body));
    },
    async fetchPublic(url) {
      if (!isUrlUnderBase(url, base)) throw new HttpError(400, 'url is outside the public bucket');
      const key = keyFromPublicUrl(url, base);
      const body = objects.get(key);
      if (!body) throw new PublicObjectError(404, 'public object unavailable (HTTP 404)');
      return Buffer.from(body);
    },
    async list() {
      throw new HttpError(503, 'Public listing is disabled');
    },
  };
}
