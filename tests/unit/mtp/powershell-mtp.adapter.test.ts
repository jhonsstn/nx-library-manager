import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { PowerShellMtpAdapter } from '@main/mtp/powershell-mtp.adapter';
import { encodeCommand, readScript, type PowerShellRunOptions } from '@main/mtp/powershell-runner';

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
      expect(run.mock.calls[0]?.[0].env).toMatchObject({
        SWITCH_CATALOG_MTP_SOURCE_COUNT: '2',
        SWITCH_CATALOG_MTP_SOURCE_0: paths[0],
        SWITCH_CATALOG_MTP_SOURCE_1: paths[1],
      });
      expect(states).toEqual(['preparing', 'copying', 'completed']);
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });

  it('retains PowerShell stage output when a transfer fails', async () => {
    const folder = mkdtempSync(join(tmpdir(), 'mtp-failure-'));
    const sourcePath = join(folder, 'Base.nsp');
    try {
      writeFileSync(sourcePath, 'file');
      const adapter = new PowerShellMtpAdapter({ scriptsDir, run: async () => ({
        code: 1, stdout: 'MTP_FALLBACK: MTP_PRETRANSFER_FAILED at resolve destination\n',
        stderr: 'Shell transfer failed for Base.nsp: device disconnected',
      }) });
      await expect(adapter.copyFiles({ files: [{ sourcePath, fileName: 'Base.nsp', totalBytes: 4 }],
        destination: { id: 'sd', name: 'SD install', label: 'SD install', shellPath: 'shell:::sd',
          freeBytes: 100, totalBytes: 200 } })).rejects.toMatchObject({
        code: 'MTP_COPY_FAILED', details: {
          exitCode: 1, stdout: expect.stringContaining('MTP_PRETRANSFER_FAILED'),
          stderr: expect.stringContaining('device disconnected'),
        },
      });
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform !== 'win32')('keeps seven paths separate in Windows PowerShell', () => {
    const paths = Array.from({ length: 7 }, (_, index) =>
      `D:\\Games Download\\Dead Cells [NSP]\\Dead Cells DLC ${index} [v0].nsp`);
    const copyScript = readScript('mtp-copy-files.ps1', { scriptsDir });
    const preamble = copyScript.split('# Validate the whole batch')[0];
    const script = `${preamble}\nWrite-Output (ConvertTo-Json -InputObject $sourcePaths -Compress)`;
    const env = { ...process.env, SWITCH_CATALOG_MTP_SOURCE_COUNT: String(paths.length),
      ...Object.fromEntries(paths.map((path, index) => [`SWITCH_CATALOG_MTP_SOURCE_${index}`, path])) };
    const result = spawnSync('powershell.exe', ['-NoProfile', '-EncodedCommand', encodeCommand(script)],
      { env, encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout.trim())).toEqual(paths);
  });

  it.skipIf(process.platform !== 'win32')('runs the batch script against a Windows folder', () => {
    const folder = mkdtempSync(join(tmpdir(), 'mtp-script-'));
    try {
      const destination = join(folder, 'destination');
      const sources = [join(folder, 'base', 'Base.nsp'), join(folder, 'dlc', 'DLC.nsp')];
      mkdirSync(destination);
      for (const source of sources) {
        mkdirSync(dirname(source));
        writeFileSync(source, 'content');
      }
      const env = { ...process.env, SWITCH_CATALOG_MTP_DESTINATION: destination,
        SWITCH_CATALOG_MTP_TIMEOUT: '30', SWITCH_CATALOG_MTP_SOURCE_COUNT: String(sources.length),
        ...Object.fromEntries(sources.map((source, index) => [`SWITCH_CATALOG_MTP_SOURCE_${index}`, source])) };
      const result = spawnSync('powershell.exe', ['-NoProfile', '-STA', '-EncodedCommand',
        encodeCommand(readScript('mtp-copy-files.ps1', { scriptsDir }))],
      { env, encoding: 'utf8', timeout: 60_000 });
      expect(result.status, result.stderr).toBe(0);
      for (const source of sources) expect(existsSync(join(destination, source.split('\\').at(-1)!))).toBe(true);
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
