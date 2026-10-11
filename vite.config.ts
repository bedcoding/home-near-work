import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

const server = 'http://127.0.0.1:8787';

export default defineConfig({
  root: 'web',
  plugins: [vue()],
  server: {
    port: 5173,
    proxy: { '/api': server, '/runs': server },
  },
  build: { outDir: 'dist', emptyOutDir: true },
});
