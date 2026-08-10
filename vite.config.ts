import { defineConfig } from 'vite';

// Served from the root of eclipse.hammantlabs.com. Override with BASE_PATH when
// hosting under a subpath (e.g. GitHub Pages project sites serve from /<repo>/).
export default defineConfig({
  base: process.env.BASE_PATH ?? '/',
  build: { outDir: 'dist', sourcemap: true },
});
