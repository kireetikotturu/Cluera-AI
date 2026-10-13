import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig({
  plugins: [react()],
  root: path.resolve(__dirname, 'src/renderer'),
  base: './',
  build: {
    outDir: path.resolve(__dirname, 'dist/renderer'),
    emptyOutDir: false,
    rollupOptions: { input: { app: path.resolve(__dirname, 'src/renderer/index.html'), area: path.resolve(__dirname, 'src/renderer/area.html') } },
  },
  resolve: {
    alias: { '@shared': path.resolve(__dirname, 'src/shared') },
  },
});
