import { ConflictException } from '@nestjs/common';

/**
 * Raised when the cache is used without a bound tenant transaction (no organisation / workspace GUC, or no active
 * transaction). Fail closed: the cache never guesses a tenant and never reads without one. A programming error, so it
 * surfaces as a 500, not as an empty result.
 */
export class MetadataCacheContextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MetadataCacheContextError';
  }
}

/**
 * M2 optimistic concurrency: the caller's `expectedVersion` is not the current one (someone else changed the workspace's
 * metadata first). 409, per OWNER-METADATA-ENGINE / M0-BACKEND §2.4 step 3.1.
 */
export class MetadataVersionConflictError extends ConflictException {
  constructor(readonly expectedVersion: string, readonly currentVersion: string | null) {
    super({ statusCode: 409, error: 'Conflict', message: 'The data model changed since it was loaded. Reload and try again.', code: 'METADATA_VERSION_CONFLICT' });
  }
}
