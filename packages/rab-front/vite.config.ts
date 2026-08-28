import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  root: __dirname,
  cacheDir: '../../node_modules/.vite/rab-front',
  plugins: [react()],
  build: {
    outDir: '../../dist/packages/rab-front',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
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
});
