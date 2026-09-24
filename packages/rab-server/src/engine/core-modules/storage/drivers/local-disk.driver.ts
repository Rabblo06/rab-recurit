import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';

import { StorageError, StorageErrorCode } from '../storage.errors';
import { StorageDriverInterface, StorageObjectHead, StoragePutOptions } from './interfaces/storage-driver.interface';

/**
 * Development / unit-test driver — writes to THIS process's own disk. It is
 * deliberately incapable of multi-process operation (a file written by the
 * worker is invisible to the API), which is exactly why STORAGE_DRIVER=S3 is
 * mandatory in staging and production. It exists so developers need no cloud
 * credentials and unit tests need no network.
 */
export class LocalDiskDriver implements StorageDriverInterface {
  readonly name = 'LOCAL' as const;
  readonly bucket = null;
  readonly supportsSignedUrls = false;

  constructor(private readonly root: string) {}

  /** Defense in depth — file keys are always server-constructed, but never trust a single layer. */
  private resolvePath(key: string): string {
    const rootResolved = resolve(this.root);
    const full = resolve(rootResolved, key);
    if (full !== rootResolved && !full.startsWith(`${rootResolved}${sep}`)) {
      throw new StorageError(StorageErrorCode.UPLOAD_FAILED, 'Invalid storage key.', false);
    }
    return full;
  }

  async put(key: string, body: Buffer, _options: StoragePutOptions): Promise<void> {
    const path = this.resolvePath(key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, body);
  }

  async get(key: string): Promise<Buffer | null> {
    try {
      return await readFile(this.resolvePath(key));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      if (error instanceof StorageError) throw error;
      throw new StorageError(StorageErrorCode.DOWNLOAD_FAILED, 'The stored object could not be read.', false);
    }
  }

  async head(key: string): Promise<StorageObjectHead | null> {
    try {
      const info = await stat(this.resolvePath(key));
      return { sizeBytes: info.size };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      if (error instanceof StorageError) throw error;
      throw new StorageError(StorageErrorCode.DOWNLOAD_FAILED, 'The stored object could not be read.', false);
    }
  }

  async delete(key: string): Promise<void> {
    try {
      await rm(this.resolvePath(key));
    } catch {
      // Idempotent — deleting an already-gone file is not an error.
    }
  }

  async *list(prefix: string): AsyncIterable<{ key: string; sizeBytes: number }> {
    const rootResolved = resolve(this.root);
    const walk = async function* (dir: string): AsyncIterable<{ key: string; sizeBytes: number }> {
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) yield* walk(full);
        else yield { key: full.slice(rootResolved.length + 1).split(sep).join('/'), sizeBytes: (await stat(full)).size };
      }
    };
    for await (const item of walk(rootResolved)) {
      if (item.key.startsWith(prefix)) yield item;
    }
  }

  async signedGetUrl(): Promise<string> {
    throw new StorageError(StorageErrorCode.NOT_SUPPORTED, 'The LOCAL storage driver cannot mint signed URLs.', false);
  }

  async signedPutUrl(): Promise<string> {
    throw new StorageError(StorageErrorCode.NOT_SUPPORTED, 'The LOCAL storage driver cannot mint signed URLs.', false);
  }
}
