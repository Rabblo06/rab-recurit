/**
 * Part C3: the real UpgradeCommandHost (upgrade-commands/upgrade-command.ts) the upgrade runner lends an upgrade command.
 * Commands themselves import no fs / env / crypto (source guard); this is the one reviewed place they reach the host.
 */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
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
      const st = await lstat(path).catch(() => null);
      if (!st || !st.isFile() || st.size > maxBytes) return null;
      const handle = await open(path, 'r');
      try {
        const buffer = Buffer.alloc(st.size);
        const { bytesRead } = await handle.read(buffer, 0, st.size, 0);
        return buffer.subarray(0, bytesRead).toString('utf8');
      } finally {
        await handle.close();
      }
    },
    async fileDigest(path) {
      const st = await lstat(path).catch(() => null);
      if (!st || !st.isFile()) return null;
      const hash = createHash('sha256');
      let head = Buffer.alloc(0);
      let size = 0;
      await new Promise<void>((resolve, reject) => {
        const stream = createReadStream(path);
        stream.on('data', (chunk: Buffer | string) => {
          const b = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
          if (head.length < 8) head = Buffer.concat([head, b.subarray(0, 8 - head.length)]);
          size += b.length;
          hash.update(b);
        });
        stream.on('error', reject);
        stream.on('end', () => resolve());
      });
      return { sha256: hash.digest('hex'), size, head: head.toString('latin1') };
    },
  };
}
