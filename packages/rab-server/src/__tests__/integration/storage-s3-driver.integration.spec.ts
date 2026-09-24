import 'reflect-metadata';
import { HeadObjectCommand, ListBucketsCommand, S3Client } from '@aws-sdk/client-s3';
import { createHash, randomUUID } from 'node:crypto';

import { S3StorageDriver } from '../../engine/core-modules/storage/drivers/s3.driver';
import { StorageError, StorageErrorCode } from '../../engine/core-modules/storage/storage.errors';
import { S3_TEST } from './helpers/s3-env';

/**
 * The real S3 driver against a real S3-compatible server (MinIO). Gated on
 * RAB_TEST_S3=1 so a developer without the container still gets a green
 * default run; CI starts MinIO and sets it. Nothing here is mocked: signatures,
 * expiry, encryption headers and error classes are what the SDK and server
 * actually do.
 */
const describeIf = S3_TEST.enabled ? describe : describe.skip;

const driver = (overrides: Partial<ConstructorParameters<typeof S3StorageDriver>[0]> = {}) =>
  new S3StorageDriver({
    bucket: S3_TEST.bucket,
    region: S3_TEST.region,
    endpoint: S3_TEST.endpoint,
    accessKeyId: S3_TEST.accessKeyId,
    secretAccessKey: S3_TEST.secretAccessKey,
    forcePathStyle: true,
    serverSideEncryption: 'AES256',
    ...overrides,
  });

const key = () => `test/driver/${randomUUID()}.bin`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describeIf('S3 storage driver (real MinIO)', () => {
  const d = driver();
  const sdk = new S3Client({
    region: S3_TEST.region,
    endpoint: S3_TEST.endpoint,
    forcePathStyle: true,
    credentials: { accessKeyId: S3_TEST.accessKeyId, secretAccessKey: S3_TEST.secretAccessKey },
  });

  it('put / head / get / delete round-trip, with the SHA-256 recorded as object metadata', async () => {
    const k = key();
    const body = Buffer.from('hello object storage');
    const sha = createHash('sha256').update(body).digest('hex');
    await d.put(k, body, { contentType: 'text/plain', sha256: sha });

    const head = await d.head(k);
    expect(head).toMatchObject({ sizeBytes: body.length, contentType: 'text/plain', sha256: sha });
    expect((await d.get(k))!.equals(body)).toBe(true);

    await d.delete(k);
    expect(await d.head(k)).toBeNull();
    expect(await d.get(k)).toBeNull();
    await expect(d.delete(k)).resolves.toBeUndefined(); // idempotent
  });

  it('a missing object is null, never an exception and never a false success', async () => {
    expect(await d.get(key())).toBeNull();
    expect(await d.head(key())).toBeNull();
  });

  it('objects are encrypted at rest (SSE-S3 header is sent and honoured by the server)', async () => {
    const k = key();
    await d.put(k, Buffer.from('secret payroll pdf'), { contentType: 'application/pdf' });
    const head = await sdk.send(new HeadObjectCommand({ Bucket: S3_TEST.bucket, Key: k }));
    expect(head.ServerSideEncryption).toBe('AES256');
    await d.delete(k);
  });

  it('the bucket is PRIVATE: an anonymous request for an existing object is refused', async () => {
    const k = key();
    await d.put(k, Buffer.from('private'), { contentType: 'text/plain' });
    const anonymous = await fetch(`${S3_TEST.endpoint}/${S3_TEST.bucket}/${k}`);
    expect(anonymous.status).toBe(403);
    const listing = await fetch(`${S3_TEST.endpoint}/${S3_TEST.bucket}/?list-type=2`);
    expect(listing.status).toBe(403);
    await d.delete(k);
  });

  it('a presigned GET works for exactly that object, carries an attachment disposition, and STOPS working after expiry', async () => {
    const k = key();
    const body = Buffer.from('%PDF-1.4 fake but pdf-shaped');
    await d.put(k, body, { contentType: 'application/pdf' });
    const url = await d.signedGetUrl(k, { ttlSeconds: 2, filename: 'report.pdf', contentType: 'application/pdf' });

    const ok = await fetch(url);
    expect(ok.status).toBe(200);
    expect(ok.headers.get('content-disposition')).toContain('attachment');
    expect(ok.headers.get('content-disposition')).toContain('report.pdf');
    expect(ok.headers.get('content-type')).toBe('application/pdf');
    expect(Buffer.from(await ok.arrayBuffer()).equals(body)).toBe(true);

    await sleep(3500);
    const expired = await fetch(url);
    expect(expired.status).toBe(403); // expired signature
    await d.delete(k);
  });

  it('a TAMPERED presigned URL is refused: changing the key, the signature or the lifetime breaks it', async () => {
    const k = key();
    const other = key();
    await d.put(k, Buffer.from('a'), { contentType: 'text/plain' });
    await d.put(other, Buffer.from('b'), { contentType: 'text/plain' });
    const url = await d.signedGetUrl(k, { ttlSeconds: 60, filename: 'a.txt', contentType: 'text/plain' });

    expect((await fetch(url.replace(k, other))).status).toBe(403); // swap in another object's key
    expect((await fetch(url.replace(/X-Amz-Signature=[0-9a-f]+/, `X-Amz-Signature=${'0'.repeat(64)}`))).status).toBe(403);
    expect((await fetch(url.replace(/X-Amz-Expires=\d+/, 'X-Amz-Expires=99999'))).status).toBe(403); // extending the lifetime
    await d.delete(k);
    await d.delete(other);
  });

  it('a presigned PUT is bound to the exact key, size and content type', async () => {
    const k = key();
    const body = Buffer.from('exactly-this-many-bytes');
    const url = await d.signedPutUrl(k, { ttlSeconds: 60, contentType: 'image/png', contentLength: body.length });
    const headers = { 'Content-Type': 'image/png', 'x-amz-server-side-encryption': 'AES256' };

    // Wrong content type is rejected (part of the signature).
    expect((await fetch(url, { method: 'PUT', body, headers: { ...headers, 'Content-Type': 'text/html' } })).status).toBe(403);
    // Wrong length is rejected.
    expect((await fetch(url, { method: 'PUT', body: Buffer.concat([body, Buffer.from('!!')]), headers })).status).toBeGreaterThanOrEqual(400);
    expect(await d.head(k)).toBeNull(); // nothing landed

    // The exact request succeeds — and only writes THAT key.
    expect((await fetch(url, { method: 'PUT', body, headers })).status).toBe(200);
    expect((await d.get(k))!.equals(body)).toBe(true);
    // Reusing the URL for a different key is impossible: the key is inside the signature.
    const elsewhere = url.replace(k, key());
    expect((await fetch(elsewhere, { method: 'PUT', body, headers })).status).toBe(403);
    await d.delete(k);
  });

  it('list() pages through a prefix', async () => {
    const prefix = `test/list-${randomUUID()}/`;
    const keys = Array.from({ length: 3 }, (_, i) => `${prefix}${i}.bin`);
    for (const k of keys) await d.put(k, Buffer.from('x'), { contentType: 'application/octet-stream' });
    const seen: string[] = [];
    for await (const o of d.list(prefix)) seen.push(o.key);
    expect(seen.sort()).toEqual(keys);
    for (const k of keys) await d.delete(k);
  });

  describe('error mapping (no provider detail ever escapes)', () => {
    it('wrong credentials -> STORAGE_PERMISSION_ERROR, NOT retryable', async () => {
      const bad = driver({ secretAccessKey: 'definitely-wrong' });
      const error = await bad.put(key(), Buffer.from('x'), { contentType: 'text/plain' }).then(() => null, (e) => e as StorageError);
      expect(error).toBeInstanceOf(StorageError);
      expect(error!.code).toBe(StorageErrorCode.PERMISSION_ERROR);
      expect(error!.retryable).toBe(false);
      expect(error!.message).not.toMatch(/definitely-wrong|rab_minio|SignatureDoesNotMatch|<Error>/);
    });

    it('missing bucket -> STORAGE_PERMISSION_ERROR (a config fault, not "object not found")', async () => {
      const wrong = driver({ bucket: `nope-${randomUUID()}` });
      const error = await wrong.put(key(), Buffer.from('x'), { contentType: 'text/plain' }).then(() => null, (e) => e as StorageError);
      expect(error!.code).toBe(StorageErrorCode.PERMISSION_ERROR);
      expect(error!.retryable).toBe(false);
    });

    it('unreachable endpoint -> STORAGE_TEMPORARILY_UNAVAILABLE, retryable, and bounded in time', async () => {
      const dead = driver({ endpoint: 'http://127.0.0.1:1', maxAttempts: 2, requestTimeoutMs: 1500 });
      const started = Date.now();
      const error = await dead.put(key(), Buffer.from('x'), { contentType: 'text/plain' }).then(() => null, (e) => e as StorageError);
      expect(error).toBeInstanceOf(StorageError);
      expect(error!.code).toBe(StorageErrorCode.TEMPORARILY_UNAVAILABLE);
      expect(error!.retryable).toBe(true);
      expect(Date.now() - started).toBeLessThan(15_000); // bounded retries, never a hang
    });

    it('the SDK can reach the server at all (sanity for the rest of the matrix)', async () => {
      await expect(sdk.send(new ListBucketsCommand({}))).resolves.toBeDefined();
    });
  });
});
