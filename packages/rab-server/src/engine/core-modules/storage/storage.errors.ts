/**
 * Storage failures as RAB error classes. Raw provider errors (AWS SDK
 * exceptions carry request ids, bucket names, hostnames) never reach a client
 * or a log line: drivers map them to one of these codes and keep only the
 * safe fields.
 */
export const StorageErrorCode = {
  UPLOAD_FAILED: 'STORAGE_UPLOAD_FAILED',
  DOWNLOAD_FAILED: 'STORAGE_DOWNLOAD_FAILED',
  OBJECT_NOT_FOUND: 'STORAGE_OBJECT_NOT_FOUND',
  TEMPORARILY_UNAVAILABLE: 'STORAGE_TEMPORARILY_UNAVAILABLE',
  INTEGRITY_FAILED: 'STORAGE_INTEGRITY_FAILED',
  PERMISSION_ERROR: 'STORAGE_PERMISSION_ERROR',
  NOT_SUPPORTED: 'STORAGE_NOT_SUPPORTED',
} as const;

export type StorageErrorCodeType = (typeof StorageErrorCode)[keyof typeof StorageErrorCode];

export class StorageError extends Error {
  constructor(
    readonly code: StorageErrorCodeType,
    message: string,
    /**
     * Whether a retry could plausibly succeed. Timeouts, throttling and 5xx are retryable; a wrong credential, a
     * missing bucket or an integrity mismatch is not — a background job must not loop on those.
     */
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'StorageError';
  }
}

/** Maps an AWS SDK v3 / S3-compatible error to a StorageError WITHOUT copying the provider's message. */
export function mapProviderError(error: unknown, operation: 'put' | 'get' | 'head' | 'delete' | 'sign'): StorageError {
  const e = error as {
    name?: string;
    Code?: string;
    code?: string;
    cause?: { code?: string };
    errors?: Array<{ code?: string }>;
    $metadata?: { httpStatusCode?: number };
    $retryable?: unknown;
  } | null;
  // Network failures often arrive as an AggregateError (dual-stack connect attempts) whose useful identifier is a
  // `code` on the error, its cause, or its members — not its `name`. Collect every candidate.
  const candidates = [e?.name, e?.Code, e?.code, e?.cause?.code, ...(e?.errors ?? []).map((inner) => inner.code)].filter((v): v is string => typeof v === 'string');
  const name = candidates.find((c) => c !== 'Error' && c !== 'AggregateError') ?? candidates[0] ?? '';
  const status = e?.$metadata?.httpStatusCode;

  if (name === 'NoSuchKey' || name === 'NotFound' || name === 'NoSuchBucket' || status === 404) {
    // A missing BUCKET is a configuration fault, not a missing object.
    if (name === 'NoSuchBucket') return new StorageError(StorageErrorCode.PERMISSION_ERROR, 'The configured storage bucket does not exist.', false);
    return new StorageError(StorageErrorCode.OBJECT_NOT_FOUND, 'The stored object was not found.', false);
  }
  if (name === 'AccessDenied' || name === 'InvalidAccessKeyId' || name === 'SignatureDoesNotMatch' || name === 'AllAccessDisabled' || status === 401 || status === 403) {
    return new StorageError(StorageErrorCode.PERMISSION_ERROR, 'Storage credentials or permissions are not valid for this operation.', false);
  }
  const transient =
    /ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH|socket hang up|timed out|timeout/i.test(String((error as { message?: unknown } | null)?.message ?? '')) ||
    candidates.some((c) => ['ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT', 'EPIPE', 'EHOSTUNREACH', 'ENETUNREACH'].includes(c)) ||
    ['TimeoutError', 'RequestTimeout', 'RequestTimeoutException', 'ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT', 'SlowDown', 'ServiceUnavailable', 'InternalError', 'Throttling', 'ThrottlingException', 'NetworkingError'].includes(name) ||
    (typeof status === 'number' && (status >= 500 || status === 429)) ||
    Boolean(e?.$retryable);
  if (transient) {
    return new StorageError(StorageErrorCode.TEMPORARILY_UNAVAILABLE, 'Object storage is temporarily unavailable.', true);
  }
  return operation === 'get' || operation === 'head'
    ? new StorageError(StorageErrorCode.DOWNLOAD_FAILED, 'The stored object could not be read.', false)
    : new StorageError(StorageErrorCode.UPLOAD_FAILED, 'The object could not be stored.', false);
}
