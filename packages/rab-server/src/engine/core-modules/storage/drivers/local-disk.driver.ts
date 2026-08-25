import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';

import { StorageDriverInterface } from './interfaces/storage-driver.interface';

/**
 * Interim driver (mirrors EmailDriverFactory's EMAIL_DRIVER=LOGGER role) —
 * writes to the API server's own disk. Fine for a single-instance
 * deployment; won't survive a multi-instance one (a file written by one
 * instance is invisible to another serving the next GET). The interface is
 * kept storage-backend-agnostic so an S3 driver is a later addition, not a
 * call-site rewrite — see the [INFO] finding in the Settings implementation
 * plan.
 */
export class LocalDiskDriver implements StorageDriverInterface {
  constructor(private readonly root: string) {}

  /** Defense in depth — StorageService already only ever constructs server-side keys, but never trust a single layer. */
  private resolvePath(key: string): string {
    const rootResolved = resolve(this.root);
    const full = resolve(rootResolved, key);
    if (full !== rootResolved && !full.startsWith(`${rootResolved}${sep}`)) {
      throw new Error('Invalid storage key.');
    }
    return full;
  }

  async write(key: string, buffer: Buffer): Promise<void> {
    const path = this.resolvePath(key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, buffer);
  }

  async read(key: string): Promise<Buffer | null> {
    try {
      return await readFile(this.resolvePath(key));
    } catch {
      return null;
    }
  }

  async delete(key: string): Promise<void> {
    try {
      await rm(this.resolvePath(key));
    } catch {
      // Idempotent — deleting an already-gone file is not an error.
    }
  }
}
