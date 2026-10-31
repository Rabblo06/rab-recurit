// The screen-traffic Vite configuration: serves a rab-front checkout (read-only) on 127.0.0.1:23173 and proxies /rest to
// the harness API only. Used inline by measure-web.mjs (createServer({ configFile: false, ...webViteConfig(...) })), so
// the front's own vite.config.ts, .env files and cache directory are never read or written.
export const WEB_PORT = 23173;
export const WEB_ORIGIN = `http://127.0.0.1:${WEB_PORT}`;
const ALLOWED_API = /^http:\/\/127\.0\.0\.1:(23070)$/; // the harness API (COST_API_PORT default); nothing else

export function webViteConfig({ front, react, apiOrigin, cacheDir, envDir }) {
  if (!ALLOWED_API.test(apiOrigin)) throw new Error(`refusing API target ${apiOrigin}: only the harness API is allowed`);
  return {
    root: front,
    configFile: false,
    envDir, // an empty directory: VITE_API_URL comes from process.env (set by measure-web.mjs), nothing from the checkout
    cacheDir, // outside every checkout
    logLevel: 'warn',
    clearScreen: false,
    plugins: [react()],
    server: {
      host: '127.0.0.1',
      port: WEB_PORT,
      strictPort: true,
      hmr: false,
      watch: { ignored: ['**/*'] }, // never watch the checkout: nothing changes during a measurement
      // Same-origin API through the dev proxy (the front's own VITE_API_PROXY_TARGET topology). Host is preserved, as there.
      proxy: { '/rest': { target: apiOrigin, changeOrigin: false } },
    },
  };
}
