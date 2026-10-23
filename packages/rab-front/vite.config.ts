import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';

/**
 * Wave 3 lane H — local workspace-host testing at http://<label>.localhost:5173 (browsers resolve *.localhost to
 * loopback). `.localhost` subdomains are allowed explicitly (Vite's DNS-rebinding host check), plus any extra hosts listed
 * in VITE_ALLOWED_HOSTS (comma-separated, e.g. `.workspaces.example.test`). Never `true` (that disables the check).
 *
 * VITE_API_PROXY_TARGET (optional, dev only): proxies `/rest` to the API so a workspace host calls the API SAME-ORIGIN
 * (set VITE_API_URL=/rest/v1). The Host header is preserved (changeOrigin: false), which is how the API learns the
 * workspace host in this topology, and the session cookie is then host-only on that workspace host. Without it the app
 * calls VITE_API_URL cross-origin, and on `*.localhost` a SameSite=Lax session cookie for `localhost:3000` is cross-site.
 */
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, __dirname, 'VITE_');
  const extraHosts = (env.VITE_ALLOWED_HOSTS ?? '')
    .split(',')
    .map((h) => h.trim())
    .filter(Boolean);
  const proxyTarget = env.VITE_API_PROXY_TARGET?.trim();
  return {
    root: __dirname,
    cacheDir: '../../node_modules/.vite/rab-front',
    plugins: [react()],
    build: {
      outDir: '../../dist/packages/rab-front',
      emptyOutDir: true,
    },
    server: {
      port: 5173,
      allowedHosts: ['.localhost', ...extraHosts],
      ...(proxyTarget
        ? {
            proxy: {
              '/rest': { target: proxyTarget, changeOrigin: false, ws: true },
            },
          }
        : {}),
      // Docker Desktop on Windows doesn't reliably propagate inotify events
      // across the Windows->Linux bind mount (this repo lives at C:\Rab-recruit,
      // not inside WSL2's own filesystem), so Vite's default chokidar watcher
      // never sees host-side edits and HMR silently never fires. Polling is the
      // standard workaround. Harmless outside Docker (native fs events still work).
      watch: {
        usePolling: true,
        interval: 300,
      },
    },
  };
});
