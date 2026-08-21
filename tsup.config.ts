import { defineConfig } from 'tsup'

export default defineConfig([
  {
    entry: ['src/index.ts'],
    format: ['esm'],
    platform: 'node',
    target: 'node22',
    sourcemap: true,
    clean: true,
    dts: false,
    splitting: false,
    minify: false,
    banner: {
      js: '#!/usr/bin/env node'
    }
  },
  {
    // Pi extension loaded into the pi subprocess via `pi -e`. Its pi imports are
    // resolved by pi's own extension loader at runtime, so keep them external.
    entry: { 'acp-client-fs': 'src/pi-ext/acp-client-fs.ts' },
    format: ['esm'],
    platform: 'node',
    target: 'node22',
    sourcemap: false,
    clean: false,
    dts: false,
    splitting: false,
    minify: false,
    external: ['@earendil-works/pi-coding-agent']
  }
])
