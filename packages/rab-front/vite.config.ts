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
  // Read from the environment as well as .env files: docker-compose.yml sets it on the container.
  const pollWatch = (env.VITE_WATCH_POLLING ?? process.env.VITE_WATCH_POLLING) === 'true';
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
      // Docker Desktop on Windows doesn't reliably propagate inotify events across the Windows->Linux bind mount (this repo
      // lives at C:\Rab-recruit, not inside WSL2's own filesystem), so the dev container (docker-compose.yml `front`) sets
      // VITE_WATCH_POLLING=true. Polling is OFF everywhere else: measured 2026-11-11, it kept ~29 % of a CPU core busy
      // while idle and slowed every first module transform in the container. VITE_WATCH_INTERVAL tunes it (default 300 ms).
      ...(pollWatch
        ? { watch: { usePolling: true, interval: Number(env.VITE_WATCH_INTERVAL ?? process.env.VITE_WATCH_INTERVAL ?? 300) || 300 } }
        : {}),
      // Transform the shell and the main pages at start-up instead of on the first click (the dev server serves every
      // module separately; in the container a page's first transform took 1-4 s).
      warmup: {
        clientFiles: [
          './src/main.tsx',
          './src/App.tsx',
          './src/shell/Layout.tsx',
          './src/features/dashboard/Dashboard.tsx',
          './src/features/users/Users.tsx',
          './src/features/scheduling/Shifts.tsx',
          './src/features/scheduling/Calendar.tsx',
          './src/features/payroll/Payroll.tsx',
          './src/features/offers/Offers.tsx',
          './src/features/venues/Venues.tsx',
          './src/features/settings/layout/SettingsLayout.tsx',
          './src/features/settings/profile/ProfilePage.tsx',
        ],
      },
    },
    // Pre-bundle React and the heavy libraries reached through lazy() routes, like Twenty: otherwise Vite could discover
    // one mid-session and re-optimise + reload the page. (No mid-session re-optimise was seen in the 2026-11-11
    // measurement; this keeps it that way when imports change.)
    optimizeDeps: {
      include: [
        'react',
        'react-dom',
        'react-dom/client',
        'react/jsx-runtime',
        'react/jsx-dev-runtime',
        'react-router-dom',
        '@tanstack/react-query',
        'axios',
        'framer-motion',
        'recharts',
        'react-phone-number-input',
        '@tabler/icons-react',
      ],
    },
  };
});
