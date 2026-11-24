import { defineConfig } from 'vite';

// Relative base so the built PWA also works from any static host / subpath.
export default defineConfig({
  base: './',
  build: {
    target: 'es2022',
    outDir: 'dist',
  },
});
