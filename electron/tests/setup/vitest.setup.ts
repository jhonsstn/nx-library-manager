import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Tests must never touch the real user data directory. `TEMP_ROOT` is a
 * per-run scratch directory that suites create isolated case folders inside via
 * `mkdtempSync(join(TEMP_ROOT, 'case-'))`.
 */
export const TEMP_ROOT = mkdtempSync(join(tmpdir(), 'switch-catalog-tests-'));

process.on('exit', () => {
  try {
    rmSync(TEMP_ROOT, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});
