import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { PowerShellMtpAdapter } from '@main/mtp/powershell-mtp.adapter';
import type { PowerShellRunOptions } from '@main/mtp/powershell-runner';

const scriptsDir = resolve(process.cwd(), 'resources', 'scripts');

describe('PowerShell MTP inventory adapter', () => {
  it('uses the restored single-file Shell script and logs copy failures', async () => {
    const folder = mkdtempSync(join(tmpdir(), 'mtp-copy-'));
    const sourcePath = join(folder, 'Base.nsp');
    try {
      writeFileSync(sourcePath, 'file');
      const run = vi.fn(async (_options: PowerShellRunOptions) => ({ code: 1,
        stdout: '', stderr: 'DBI stopped the transfer' }));
      const logError = vi.fn();
      const logger = { child: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: logError };
      const adapter = new PowerShellMtpAdapter({ scriptsDir, run, logger });
      await expect(adapter.copyFile({ sourcePath, fileName: 'Base.nsp', totalBytes: 4,
        destination: { id: 'sd', name: 'SD install', label: 'SD install', shellPath: 'shell:::sd',
          freeBytes: 100, totalBytes: 200 } })).rejects.toMatchObject({ code: 'MTP_COPY_FAILED',
        details: { exitCode: 1, stderr: 'DBI stopped the transfer' } });
      expect(run).toHaveBeenCalledTimes(1);
      expect(run.mock.calls[0]?.[0].env).toMatchObject({
        SWITCH_CATALOG_MTP_SOURCE: sourcePath, SWITCH_CATALOG_MTP_DESTINATION: 'shell:::sd',
      });
      expect(run.mock.calls[0]?.[0].script).toContain('$dest.CopyHere($sourcePath, 16)');
      expect(logError).toHaveBeenCalledWith('transfer.failed', expect.objectContaining({
        source: sourcePath, details: expect.objectContaining({ stderr: 'DBI stopped the transfer' }),
      }));
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
