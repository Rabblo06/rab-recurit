/**
 * Part C3: the real UpgradeCommandHost (upgrade-commands/upgrade-command.ts) the upgrade runner lends an upgrade command.
 * Commands themselves import no fs / env / crypto (source guard); this is the one reviewed place they reach the host.
 */
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { FileHandle, open } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';

import { resolveHwsRuntimeEnabled } from '../environment/hws-runtime-default';
import type { UpgradeCommandHost } from './upgrade-commands/upgrade-command';

export function createUpgradeCommandHost(overrides: { env?: Readonly<Record<string, string | undefined>>; hwsRuntimeEnabled?: boolean } = {}): UpgradeCommandHost {
  const env = Object.freeze({ ...(overrides.env ?? process.env) });
  const hwsRuntimeEnabled = overrides.hwsRuntimeEnabled ?? resolveHwsRuntimeEnabled(env.HWS_RUNTIME_ENABLED, env) === true;
  return {
    env,
    hwsRuntimeEnabled,
    isAbsolutePath: (path) => isAbsolute(path),
    siblingPath: (path, fileName) => join(dirname(path), fileName),
    async readSmallFile(path, maxBytes) {
      const handle = await openRegularNoFollow(path);
      if (!handle) return null;
      try {
        const st = await handle.stat();
        if (st.size > maxBytes) return null;
        const buffer = Buffer.alloc(st.size);
        const { bytesRead } = await handle.read(buffer, 0, st.size, 0);
        return buffer.subarray(0, bytesRead).toString('utf8');
      } finally {
        await handle.close();
      }
    },
    async fileDigest(path) {
      const handle = await openRegularNoFollow(path);
      if (!handle) return null;
      try {
        const hash = createHash('sha256');
        let head = Buffer.alloc(0);
        let size = 0;
        const chunk = Buffer.alloc(1 << 20);
        for (;;) {
          const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
          if (bytesRead === 0) break;
          const b = chunk.subarray(0, bytesRead);
          if (head.length < 8) head = Buffer.concat([head, b.subarray(0, 8 - head.length)]);
          size += bytesRead;
          hash.update(b);
        }
        return { sha256: hash.digest('hex'), size, head: head.toString('latin1') };
      } finally {
        await handle.close();
      }
    },
  };
}

/**
 * Security review Info-2: open WITHOUT following a symlink (O_NOFOLLOW; the final path component may not be a link) and
 * decide on the OPEN handle (fstat), so nothing can be swapped between a check and the open. null = absent, a symlink, or
 * not a regular file. O_NONBLOCK so a FIFO planted at the path cannot hang the start (no effect on a regular file). (Both are
 * undefined on Windows, where the upgrade never runs.)
 */
async function openRegularNoFollow(path: string): Promise<FileHandle | null> {
  let handle: FileHandle;
  try {
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  } catch {
    return null;
  }
  const st = await handle.stat().catch(() => null);
  if (!st || !st.isFile()) {
    await handle.close();
    return null;
  }
  return handle;
}
