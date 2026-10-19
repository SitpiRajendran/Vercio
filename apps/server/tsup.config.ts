import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts', 'src/cli.ts'],
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  clean: true,
  sourcemap: true,
  // Le package partagé est distribué en TypeScript : on l'embarque dans le bundle.
  noExternal: ['@vercio/shared'],
})
