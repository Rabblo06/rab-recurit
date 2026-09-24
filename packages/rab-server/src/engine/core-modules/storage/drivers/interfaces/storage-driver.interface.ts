export interface StoragePutOptions {
  contentType: string;
  /** Hex SHA-256 of the body; stored as object metadata so an object is self-describing during reconciliation. */
  sha256?: string;
}

export interface StorageObjectHead {
  sizeBytes: number;
  contentType?: string;
  /** From object metadata when the driver stored it. Advisory — the database row's sha256 is authoritative. */
  sha256?: string;
}

export interface StorageSignedGetOptions {
  ttlSeconds: number;
  /** Already sanitised by the caller (see safe-filename.ts). */
  filename: string;
  contentType: string;
}

export interface StorageSignedPutOptions {
  ttlSeconds: number;
  contentType: string;
  contentLength: number;
}

/**
 * The ONLY surface business code reaches storage through (via FileService /
 * StorageService). Nothing outside `engine/core-modules/storage/drivers`
 * may import an SDK client.
 */
export interface StorageDriverInterface {
  readonly name: 'LOCAL' | 'S3';
  /** Bucket name for S3, `null` for LOCAL — recorded in file metadata. */
  readonly bucket: string | null;
  /** LOCAL cannot mint URLs; callers stream the bytes instead. */
  readonly supportsSignedUrls: boolean;

  put(key: string, body: Buffer, options: StoragePutOptions): Promise<void>;
  /** `null` = the object does not exist. Any other failure throws a StorageError. */
  get(key: string): Promise<Buffer | null>;
  head(key: string): Promise<StorageObjectHead | null>;
  /** Idempotent: deleting an absent object is not an error. */
  delete(key: string): Promise<void>;
  /** Keys under `prefix` — reconciliation only. Yields in pages so a large bucket never sits in memory. */
  list(prefix: string): AsyncIterable<{ key: string; sizeBytes: number }>;

  signedGetUrl(key: string, options: StorageSignedGetOptions): Promise<string>;
  signedPutUrl(key: string, options: StorageSignedPutOptions): Promise<string>;
}
