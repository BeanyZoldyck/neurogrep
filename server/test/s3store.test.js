import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mockClient } from 'aws-sdk-client-mock';
import { S3Client, PutObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import {
  DEFAULT_BUCKET,
  DEFAULT_PUBLIC_BASE_URL,
  createS3Store,
  keyFromPublicUrl,
  loadS3Config,
  publicObjectUrl,
} from '../lib/s3store.js';
import { createDisabledProofs } from '../lib/proofs.js';
import { createShare } from '../lib/share.js';

const s3Mock = mockClient(S3Client);

describe('s3 store', { concurrency: 1 }, () => {
test.afterEach(() => s3Mock.reset());
test.after(() => s3Mock.restore());

test('default public URL is the us-east-1 virtual-hosted bucket', () => {
  const config = loadS3Config({});
  assert.equal(config.bucket, DEFAULT_BUCKET);
  assert.equal(config.region, 'us-east-1');
  assert.equal(config.publicBaseUrl, DEFAULT_PUBLIC_BASE_URL);
  assert.equal(config.accessKeyId, '');
  assert.equal(config.secretAccessKey, '');
  assert.equal(config.objectAcl, '');
  const key = 'videos/11111111-1111-1111-1111-111111111111.json';
  assert.equal(publicObjectUrl(config.publicBaseUrl, key), `${DEFAULT_PUBLIC_BASE_URL}/${key}`);
  assert.equal(keyFromPublicUrl(`${DEFAULT_PUBLIC_BASE_URL}/${key}`, config.publicBaseUrl), key);
  assert.equal(loadS3Config({ S3_BUCKET: '', S3_REGION: '' }).bucket, DEFAULT_BUCKET);
  assert.equal(
    loadS3Config({ S3_BUCKET: 'other', S3_REGION: 'eu-west-1' }).publicBaseUrl,
    'https://other.s3.eu-west-1.amazonaws.com',
  );
  const r2 = loadS3Config({
    S3_ENDPOINT: 'https://example.r2.cloudflarestorage.com',
    S3_PUBLIC_BASE_URL: 'https://pub-example.r2.dev',
  });
  assert.equal(r2.publicBaseUrl, 'https://pub-example.r2.dev');
  assert.equal(r2.forcePathStyle, true);
});

test('env example and README name the public bucket and contain no credentials', () => {
  const env = readFileSync(new URL('../.env.example', import.meta.url), 'utf8');
  const serverReadme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  const rootReadme = readFileSync(new URL('../../README.md', import.meta.url), 'utf8');
  assert.match(env, /^S3_BUCKET=neurogrep-public-1794752476$/m);
  assert.match(env, /^S3_REGION=us-east-1$/m);
  assert.match(env, /^S3_PUBLIC_BASE_URL=https:\/\/neurogrep-public-1794752476\.s3\.amazonaws\.com$/m);
  assert.match(env, /^S3_ACCESS_KEY_ID=$/m);
  assert.match(env, /^S3_SECRET_ACCESS_KEY=$/m);
  assert.match(env, /^VERICAM_UPLOAD_KEY=$/m);
  assert.doesNotMatch(env, /AKIA[0-9A-Z]{16}/);
  assert.match(serverReadme, /https:\/\/neurogrep-public-1794752476\.s3\.amazonaws\.com/);
  assert.match(rootReadme, /https:\/\/neurogrep-public-1794752476\.s3\.amazonaws\.com\/<key>/);
  const policy = JSON.parse(readFileSync(new URL('../s3/public-read-policy.json', import.meta.url), 'utf8'));
  assert.deepEqual(policy.Statement[0].Action, 's3:GetObject');
  assert.equal(policy.Statement[0].Principal, '*');
  assert.doesNotMatch(JSON.stringify(policy), /ListBucket|PutObject/);
});

test('verify fetches the public URL and does not call S3', async () => {
  const calls = [];
  s3Mock.on(PutObjectCommand).rejects(new Error('put should not run'));
  s3Mock.on(ListObjectsV2Command).rejects(new Error('list should not run'));
  const store = createS3Store(loadS3Config({}), {
    fetchImpl: async (url, opts) => {
      calls.push({ url, redirect: opts.redirect });
      return new Response('not-json', { status: 403 });
    },
  });
  assert.equal(store.canWrite, false);
  assert.equal(store.canList, false);
  await assert.rejects(() => store.list('videos/'), /credentials/);
  const share = createShare({ store, proofs: createDisabledProofs(), uploadKey: 'k' });
  const out = await share.check({ key: 'videos/missing.json' });
  assert.equal(out.verdict, 'unknown');
  assert.equal(out.fetch, 'public-https');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `${DEFAULT_PUBLIC_BASE_URL}/videos/missing.json`);
  assert.equal(calls[0].redirect, 'error');
  assert.equal(s3Mock.commandCalls(PutObjectCommand).length, 0);
  assert.equal(s3Mock.commandCalls(ListObjectsV2Command).length, 0);
  await assert.rejects(
    () => share.check({ url: 'http://169.254.169.254/latest/meta-data/' }),
    (err) => err.status === 400,
  );
  assert.equal(calls.length, 1);
});

test('authenticated put and list use the SDK; ACL stays unset unless asked', async () => {
  s3Mock.on(PutObjectCommand).resolves({});
  s3Mock.on(ListObjectsV2Command).resolves({
    Contents: [{ Key: 'videos/a.json' }],
    IsTruncated: false,
  });
  const store = createS3Store(loadS3Config({
    S3_ACCESS_KEY_ID: 'AKIATESTKEY',
    S3_SECRET_ACCESS_KEY: 'secret-secret-secret',
  }));
  const url = await store.put('videos/a.json', Buffer.from('{}'));
  assert.equal(url, `${DEFAULT_PUBLIC_BASE_URL}/videos/a.json`);
  const put = s3Mock.commandCalls(PutObjectCommand)[0].args[0].input;
  assert.equal(put.Bucket, DEFAULT_BUCKET);
  assert.equal(put.Key, 'videos/a.json');
  assert.equal(put.ContentType, 'application/json; charset=utf-8');
  assert.equal(put.ACL, undefined);
  assert.equal(put.CacheControl, 'no-store');
  const keys = await store.list('videos/');
  assert.deepEqual(keys, ['videos/a.json']);
  const listed = s3Mock.commandCalls(ListObjectsV2Command)[0].args[0].input;
  assert.equal(listed.Bucket, DEFAULT_BUCKET);
  assert.equal(listed.Prefix, 'videos/');

  s3Mock.reset();
  s3Mock.on(PutObjectCommand).resolves({});
  const aclStore = createS3Store(loadS3Config({
    S3_ACCESS_KEY_ID: 'AKIATESTKEY',
    S3_SECRET_ACCESS_KEY: 'secret-secret-secret',
    S3_OBJECT_ACL: 'public-read',
  }));
  await aclStore.put('videos/b.json', Buffer.from('{}'));
  assert.equal(s3Mock.commandCalls(PutObjectCommand)[0].args[0].input.ACL, 'public-read');
});
});
