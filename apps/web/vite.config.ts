import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';

export default defineConfig({
  plugins: [preact()],
  build: { outDir: 'dist', emptyOutDir: true, target: 'es2020' },
  server: {
    // `npm run dev -w @omniclip/web` proxies API calls to a hub started with `npm run dev:hub`
    proxy: {
      '/api': 'http://localhost:7879',
      '/ca.crt': 'http://localhost:7879',
      '/ws': { target: 'ws://localhost:7879', ws: true },
    },
  },
});
