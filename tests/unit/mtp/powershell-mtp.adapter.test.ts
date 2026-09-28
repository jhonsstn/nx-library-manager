import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { PowerShellMtpAdapter } from '@main/mtp/powershell-mtp.adapter';
import type { PowerShellRunOptions } from '@main/mtp/powershell-runner';

const scriptsDir = resolve(process.cwd(), 'resources', 'scripts');

describe('PowerShell MTP inventory adapter', () => {
  it('sends all selected files through one PowerShell copy operation', async () => {
    const folder = mkdtempSync(join(tmpdir(), 'mtp-batch-'));
    try {
      const paths = [join(folder, 'base', 'Base.nsp'), join(folder, 'updates', 'Update.nsp')];
      for (const path of paths) mkdirSync(dirname(path), { recursive: true });
      for (const path of paths) writeFileSync(path, 'file');
      const run = vi.fn(async (_options: PowerShellRunOptions) => ({ code: 0, stderr: '', stdout: '' }));
      const adapter = new PowerShellMtpAdapter({ scriptsDir, run });
      const states: string[] = [];
      await adapter.copyFiles({ files: paths.map((sourcePath) => ({ sourcePath,
        fileName: sourcePath, totalBytes: 4 })), destination: {
        id: 'sd', name: 'SD install', label: 'SD install', shellPath: 'shell:::sd',
        freeBytes: 100, totalBytes: 200,
      }, timeoutSeconds: 60, onStateChange: (state) => states.push(state) });
      expect(run).toHaveBeenCalledTimes(1);
      expect(run.mock.calls[0]?.[0].timeoutMs).toBe(60_000);
      expect(JSON.parse(run.mock.calls[0]?.[0].env?.SWITCH_CATALOG_MTP_SOURCES ?? '')).toEqual(paths);
      expect(states).toEqual(['preparing', 'copying', 'completed']);
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });

  it('parses a bounded, read-only installed-games listing', async () => {
    const received: PowerShellRunOptions[] = [];
    const adapter = new PowerShellMtpAdapter({ scriptsDir, run: async (options) => {
      received.push(options);
      return { code: 0, stderr: '', stdout: JSON.stringify({ state: 'ready', device_id: 'switch-1',
        files: [{ folder_name: 'Game', file_name: 'Game [0100AABBCCDD0000][v0].nsp' }],
        unidentified_files: 0, message: null }) };
    } });
    const signal = new AbortController().signal;
    await expect(adapter.listInstalledTitles(signal)).resolves.toMatchObject({
      state: 'ready', deviceId: 'switch-1', files: [{ folderName: 'Game',
        fileName: 'Game [0100AABBCCDD0000][v0].nsp' }],
    });
    expect(received[0]).toMatchObject({ timeoutMs: 60_000, signal });
    expect(received[0]?.script).toContain('$installedFolder.Items()');
    expect(received[0]?.script).not.toMatch(/CopyHere|Copy-Item|Get-Content/);
  });

  it('does not offer either device as an install destination when two Switches appear', async () => {
    const adapter = new PowerShellMtpAdapter({ scriptsDir, run: async () => ({ code: 0, stderr: '',
      stdout: JSON.stringify([
        { name: '', device_id: 'switch-1' },
        { name: 'SD install', free_bytes: 1000, total_bytes: 2000,
          path: 'shell:::switch-1\\SD install', device_id: 'switch-1' },
        { name: '', device_id: 'switch-2' },
        { name: 'SD install', free_bytes: 1000, total_bytes: 2000,
          path: 'shell:::switch-2\\SD install', device_id: 'switch-2' },
      ]) }) });
    const status = await adapter.getStatus();
    expect(status.deviceCount).toBe(2);
    expect(status.storages).toEqual([]);
    expect(status.deviceId).toBeNull();
  });

  it('rejects two Shell devices even when Windows omits their paths', async () => {
    const adapter = new PowerShellMtpAdapter({ scriptsDir, run: async () => ({ code: 0, stderr: '',
      stdout: JSON.stringify([{ name: '', device_id: '' }, { name: '', device_id: '' }]) }) });
    expect(await adapter.getStatus()).toMatchObject({ deviceCount: 2, deviceId: null, storages: [] });
  });
});
