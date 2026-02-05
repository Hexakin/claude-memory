import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/cli.ts'],
  format: ['esm'],
  outDir: 'dist',
  clean: true,
  dts: false,
  sourcemap: true,
  target: 'node22',
  banner: {
    js: '#!/usr/bin/env node',
  },
});
