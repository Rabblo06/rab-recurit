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
  },
});
