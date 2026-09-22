import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

for (const target of ['dist', 'release', 'test-results', 'playwright-report', 'tests/.tmp']) {
  rmSync(resolve(root, target), { recursive: true, force: true });
}
console.log('cleaned build output');
