import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Side-effect import — must be FIRST in a spec that boots WorkerModule against the LOCAL storage driver (the environment
 * is frozen when the Nest config module is imported). A throwaway temp directory: no network, nothing left behind that
 * matters. Phase A (storage) worker specs use it.
 */
export const LOCAL_STORAGE_ROOT = mkdtempSync(join(tmpdir(), 'rab-worker-storage-'));
process.env.STORAGE_DRIVER = 'LOCAL';
process.env.STORAGE_LOCAL_ROOT = LOCAL_STORAGE_ROOT;
process.env.STORAGE_KEY_PREFIX = 'test';
