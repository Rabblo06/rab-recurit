import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  ServerSideEncryption,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

import { StorageError, StorageErrorCode, mapProviderError } from '../storage.errors';
import {
  StorageDriverInterface,
  StorageObjectHead,
  StoragePutOptions,
  StorageSignedGetOptions,
  StorageSignedPutOptions,
} from './interfaces/storage-driver.interface';

export interface S3DriverConfig {
  bucket: string;
  region: string;
  /** Unset for AWS S3; set for R2 / Spaces / MinIO. */
  endpoint?: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle: boolean;
  /** `AES256` (SSE-S3), `aws:kms`, or `NONE` for providers that reject the header. */
  serverSideEncryption: string;
  kmsKeyId?: string;
  /** Bounded SDK-level retries; background jobs add their own backoff on top. */
  maxAttempts?: number;
  requestTimeoutMs?: number;
}

/**
 * The only place in the codebase that instantiates an S3 client. Provider
 * differences (AWS vs R2 vs Spaces vs MinIO) are configuration, not code
 * paths: `endpoint` + `forcePathStyle`.
 *
 * Nothing here logs credentials, presigned URLs or object bytes, and no raw
 * provider error escapes — everything is mapped to a StorageError first.
 */
export class S3StorageDriver implements StorageDriverInterface {
  readonly name = 'S3' as const;
  readonly supportsSignedUrls = true;
  private readonly client: S3Client;

  constructor(private readonly config: S3DriverConfig) {
    this.client = new S3Client({
      region: config.region,
      endpoint: config.endpoint,
      forcePathStyle: config.forcePathStyle,
      credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
      maxAttempts: config.maxAttempts ?? 3,
      requestHandler: { requestTimeout: config.requestTimeoutMs ?? 20_000, connectionTimeout: 5_000 },
    });
  }

  get bucket(): string {
    return this.config.bucket;
  }

  private encryption(): { ServerSideEncryption?: ServerSideEncryption; SSEKMSKeyId?: string } {
    if (this.config.serverSideEncryption === 'AES256') return { ServerSideEncryption: 'AES256' };
    if (this.config.serverSideEncryption === 'aws:kms') return { ServerSideEncryption: 'aws:kms', SSEKMSKeyId: this.config.kmsKeyId };
    return {};
  }

  async put(key: string, body: Buffer, options: StoragePutOptions): Promise<void> {
    try {
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.config.bucket,
          Key: key,
          Body: body,
          ContentType: options.contentType,
          ContentLength: body.length,
          Metadata: options.sha256 ? { sha256: options.sha256 } : undefined,
          ...this.encryption(),
        }),
      );
    } catch (error) {
      throw mapProviderError(error, 'put');
    }
  }

  async get(key: string): Promise<Buffer | null> {
    try {
      const out = await this.client.send(new GetObjectCommand({ Bucket: this.config.bucket, Key: key }));
      if (!out.Body) return null;
      return Buffer.from(await out.Body.transformToByteArray());
    } catch (error) {
      const mapped = mapProviderError(error, 'get');
      if (mapped.code === StorageErrorCode.OBJECT_NOT_FOUND) return null;
      throw mapped;
    }
  }

  async head(key: string): Promise<StorageObjectHead | null> {
    try {
      const out = await this.client.send(new HeadObjectCommand({ Bucket: this.config.bucket, Key: key }));
      return { sizeBytes: out.ContentLength ?? 0, contentType: out.ContentType, sha256: out.Metadata?.sha256 };
    } catch (error) {
      const mapped = mapProviderError(error, 'head');
      if (mapped.code === StorageErrorCode.OBJECT_NOT_FOUND) return null;
      throw mapped;
    }
  }

  async delete(key: string): Promise<void> {
    try {
      await this.client.send(new DeleteObjectCommand({ Bucket: this.config.bucket, Key: key }));
    } catch (error) {
      const mapped = mapProviderError(error, 'delete');
      if (mapped.code === StorageErrorCode.OBJECT_NOT_FOUND) return;
      throw mapped;
    }
  }

  async *list(prefix: string): AsyncIterable<{ key: string; sizeBytes: number }> {
    let token: string | undefined;
    do {
      let page;
      try {
        page = await this.client.send(new ListObjectsV2Command({ Bucket: this.config.bucket, Prefix: prefix, ContinuationToken: token, MaxKeys: 500 }));
      } catch (error) {
        throw mapProviderError(error, 'get');
      }
      for (const item of page.Contents ?? []) {
        if (item.Key) yield { key: item.Key, sizeBytes: item.Size ?? 0 };
      }
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);
  }

  /**
   * Presigned GET for ONE object, bound to a response filename and content
   * type. `attachment` disposition + nosniff-friendly type: the browser
   * downloads instead of rendering uploaded content inline.
   */
  async signedGetUrl(key: string, options: StorageSignedGetOptions): Promise<string> {
    try {
      return await getSignedUrl(
        this.client,
        new GetObjectCommand({
          Bucket: this.config.bucket,
          Key: key,
          ResponseContentType: options.contentType,
          ResponseContentDisposition: `attachment; filename="${options.filename}"`,
        }),
        { expiresIn: options.ttlSeconds },
      );
    } catch (error) {
      throw mapProviderError(error, 'sign');
    }
  }

  /**
   * Presigned PUT bound to an exact key, content type and content length. The
   * client never chooses the key; a body of a different size or type is
   * rejected by the store because those headers are part of the signature.
   */
  async signedPutUrl(key: string, options: StorageSignedPutOptions): Promise<string> {
    try {
      return await getSignedUrl(
        this.client,
        new PutObjectCommand({
          Bucket: this.config.bucket,
          Key: key,
          ContentType: options.contentType,
          ContentLength: options.contentLength,
          ...this.encryption(),
        }),
        { expiresIn: options.ttlSeconds, signableHeaders: new Set(['content-type', 'content-length', 'x-amz-server-side-encryption']) },
      );
    } catch (error) {
      throw new StorageError(StorageErrorCode.UPLOAD_FAILED, mapProviderError(error, 'sign').message, false);
    }
  }
}
