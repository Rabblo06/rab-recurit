import { defineConfig, type UserConfig } from 'vite';

import base from '../../rab-front/vite.config';

/**
 * Host-run console for the DISPOSABLE e2e stack (system/docker-compose.e2e.yml). Same app and same proxy topology as the
 * dev stack (VITE_API_URL=/rest/v1, /rest proxied with the Host preserved), on its own port and its own dependency cache
 * so it never collides with another Vite instance on this machine.
 *
 *   VITE_API_URL=/rest/v1 VITE_API_PROXY_TARGET=http://127.0.0.1:3300 \
 *     node node_modules/vite/bin/vite.js --config packages/rab-e2e-testing/system/vite.e2e.config.ts
 */
export default defineConfig(async (env) => {
  // Fail closed: without the same-origin API URL the app falls back to http://localhost:3000 — the DEV API. (Git Bash
  // rewrites a bare `/rest/v1` into a Windows path unless MSYS_NO_PATHCONV=1 is set.)
  if (process.env.VITE_API_URL !== '/rest/v1' || process.env.VITE_API_PROXY_TARGET !== 'http://127.0.0.1:3300') {
    throw new Error(`vite.e2e: refusing to start — VITE_API_URL must be /rest/v1 and VITE_API_PROXY_TARGET http://127.0.0.1:3300 (got ${process.env.VITE_API_URL} / ${process.env.VITE_API_PROXY_TARGET}).`);
  }
  const cfg = (typeof base === 'function' ? await base(env) : await base) as UserConfig;
  return {
    ...cfg,
    cacheDir: '../../node_modules/.vite/rab-front-e2e',
    server: { ...cfg.server, port: 5300, strictPort: true, host: '127.0.0.1' },
  };
});
