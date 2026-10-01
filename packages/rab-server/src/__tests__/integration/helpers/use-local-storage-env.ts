import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Import FIRST in any spec that needs real storage-state correctness
 * (PENDING/AVAILABLE/FAILED/DELETED transitions, object existence) without
 * MinIO/S3 credentials — `AppModule`'s ConfigModule freezes the environment
 * at IMPORT time, same rule as `use-s3-env.ts`.
 *
 * Whatever the developer's own `.env` has `STORAGE_DRIVER` set to (this repo's
 * convention: `.env` is real and per-developer, sometimes S3-with-real-cloud-
 * credentials) is irrelevant here — Phase 8's cleanup-race correctness does
 * not depend on which object store is behind the interface (see
 * `StorageDriverInterface`), only on the database claim ordering, so the
 * LOCAL driver against a throwaway temp directory is the right, safe default
 * for this suite: no network, no cloud credentials, nothing to leave behind.
 */
export const LOCAL_STORAGE_ROOT = mkdtempSync(join(tmpdir(), 'rab-storage-cleanup-'));

export function useLocalStorageEnv(): void {
  process.env.STORAGE_DRIVER = 'LOCAL';
  process.env.STORAGE_LOCAL_ROOT = LOCAL_STORAGE_ROOT;
  process.env.STORAGE_KEY_PREFIX = 'test';
}

useLocalStorageEnv();
