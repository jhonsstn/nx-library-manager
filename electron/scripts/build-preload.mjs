/**
 * Sandboxed preload scripts cannot `require` relative files, so the preload
 * entry point must be bundled into a single CommonJS file.
 */
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

await build({
  entryPoints: [resolve(root, 'src/preload/index.ts')],
  outfile: resolve(root, 'dist/preload/index.js'),
  bundle: true,
  platform: 'browser',
  format: 'cjs',
  target: 'chrome128',
  external: ['electron'],
  sourcemap: true,
  logLevel: 'info',
});
