import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { TEMP_ROOT } from '../../setup/vitest.setup';
import { walkLibrary, type LibraryFileEntry } from '@main/scanner/walk-library';

/** Placeholder payload: no copyrighted game data, only enough bytes to size files. */
const FILE_BYTES = Buffer.from('placeholder switch package payload');

const BASE_FILES = ['Alpha Game [0100000000000000][v0].nsp', 'Beta Game.nsz', 'Gamma Game.xci'];
const SUB_FILES = ['Sub/Delta Game.NSP', 'Sub/epsilon.nsz', 'Sub/Nest/Zeta Game.xci'];
const UPDATE_FILE = 'Updates/Alpha Game [0100000000000800][v65536].nsp';
const LOCKED_FILE = 'Locked/Hidden Game.nsp';

const SUPPORTED_FILES = [...BASE_FILES, ...SUB_FILES, UPDATE_FILE, LOCKED_FILE];

let root: string;
let locked: string;

/** Whether `chmod 000` actually blocks reads here (it does not when running as root). */
const permissionsEnforced = (() => {
  const probe = mkdtempSync(join(TEMP_ROOT, 'walk-permissions-'));
  const child = join(probe, 'child');
  mkdirSync(child);
  chmodSync(child, 0o000);
  let enforced = false;
  try {
    readdirSync(child);
  } catch {
    enforced = true;
  }
  chmodSync(child, 0o755);
  rmSync(probe, { recursive: true, force: true });
  return enforced;
})();

function place(relativePath: string, contents: Buffer = FILE_BYTES): string {
  const path = join(root, relativePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
  return path;
}

function absolute(relativePath: string): string {
  return join(root, relativePath);
}

function sortedPaths(entries: LibraryFileEntry[]): string[] {
  return entries.map((entry) => entry.path).sort();
}

beforeEach(() => {
  root = mkdtempSync(join(TEMP_ROOT, 'walk-library-'));
  locked = join(root, 'Locked');
  for (const relativePath of SUPPORTED_FILES) place(relativePath);
  // Unsupported extensions and a supported extension that is not the final suffix.
  writeFileSync(join(root, 'notes.txt'), 'not a package');
  writeFileSync(join(root, 'README Game.nsp.txt'), 'also not a package');
});

afterEach(() => {
  try {
    chmodSync(locked, 0o755);
  } catch {
    /* the unreadable-directory test restores it itself */
  }
  rmSync(root, { recursive: true, force: true });
});

describe('walkLibrary', () => {
  it('discovers supported files recursively and reports size and modified time', async () => {
    const entries = await walkLibrary({ root, recursive: true });

    expect(sortedPaths(entries)).toEqual(SUPPORTED_FILES.map(absolute).sort());
    const alpha = entries.find((entry) => entry.fileName.startsWith('Alpha Game ['))!;
    expect(alpha).toMatchObject({
      fileName: 'Alpha Game [0100000000000000][v0].nsp',
      extension: 'nsp',
      sizeBytes: FILE_BYTES.length,
    });
    expect(alpha.modifiedTime).toBeGreaterThan(0);
    expect(alpha.modifiedTime).toBeLessThanOrEqual(Date.now() + 1000);
  });

  it('stays on the top level when recursive is false', async () => {
    const entries = await walkLibrary({ root, recursive: false });

    expect(sortedPaths(entries)).toEqual(BASE_FILES.map(absolute).sort());
  });

  it('lower-cases extensions case-insensitively', async () => {
    const entries = await walkLibrary({ root, recursive: true });

    const delta = entries.find((entry) => entry.fileName === 'Delta Game.NSP')!;
    expect(delta.extension).toBe('nsp');
    expect(delta.path).toBe(absolute('Sub/Delta Game.NSP'));
  });

  it('skips an updates root nested inside the base root', async () => {
    const entries = await walkLibrary({ root, recursive: true, excludeRoots: [join(root, 'Updates')] });

    expect(sortedPaths(entries)).toEqual(
      [...BASE_FILES, ...SUB_FILES, LOCKED_FILE].map(absolute).sort(),
    );
    expect(sortedPaths(entries)).not.toContain(absolute(UPDATE_FILE));
  });

  it('reports examined entries through onBatch', async () => {
    const batches: number[] = [];
    const entries = await walkLibrary({
      root,
      recursive: true,
      onBatch: (count) => {
        batches.push(count);
      },
    });

    expect(entries).toHaveLength(SUPPORTED_FILES.length);
    expect(batches.length).toBeGreaterThan(1);
    expect(batches.reduce((total, count) => total + count, 0)).toBeGreaterThanOrEqual(entries.length);
  });

  it('returns an empty list for a missing root', async () => {
    expect(await walkLibrary({ root: join(root, 'does-not-exist'), recursive: true })).toEqual([]);
    // A file where a directory is expected is unreadable in the same way.
    expect(await walkLibrary({ root: absolute(BASE_FILES[0]), recursive: true })).toEqual([]);
  });

  it.skipIf(!permissionsEnforced)('keeps walking when a subdirectory cannot be read', async () => {
    chmodSync(locked, 0o000);

    const entries = await walkLibrary({ root, recursive: true });

    expect(sortedPaths(entries)).toEqual(
      [...BASE_FILES, ...SUB_FILES, UPDATE_FILE].map(absolute).sort(),
    );
  });

  it('returns immediately for an already aborted signal', async () => {
    const controller = new AbortController();
    controller.abort();

    expect(await walkLibrary({ root, recursive: true, signal: controller.signal })).toEqual([]);
  });

  it('stops between directory batches when the signal aborts', async () => {
    const controller = new AbortController();
    const batches: number[] = [];

    const entries = await walkLibrary({
      root,
      recursive: true,
      signal: controller.signal,
      onBatch: (count) => {
        batches.push(count);
        controller.abort();
      },
    });

    expect(batches).toHaveLength(1);
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.length).toBeLessThan(SUPPORTED_FILES.length);
  });
});
