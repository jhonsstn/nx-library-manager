import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  PowerShellError,
  cleanPowerShellMessage,
  defaultScriptsDir,
  encodeCommand,
  readScript,
  runPowerShell,
} from '@main/mtp/powershell-runner';

type SpawnStub = typeof import('node:child_process').spawn;

/** The repo's own copy of the packaged `.ps1` programs. */
const REPO_SCRIPTS = fileURLToPath(new URL('../../../resources/scripts', import.meta.url));

interface SpawnCall {
  command: string;
  args: string[];
  options: { windowsHide?: boolean; env?: Record<string, string | undefined> };
}

interface FakeChild extends EventEmitter {
  stdout: EventEmitter & { setEncoding: (encoding: string) => void };
  stderr: EventEmitter & { setEncoding: (encoding: string) => void };
  kill: (signal?: string) => boolean;
}

/**
 * Records the argv a real `spawn` would receive and lets the test drive the
 * child's lifecycle. No real PowerShell process is ever started.
 */
function createSpawnStub(options: { closeOnKill?: number | null } = {}): {
  run: SpawnStub;
  calls: SpawnCall[];
  kills: Array<string | undefined>;
  child: FakeChild;
} {
  const calls: SpawnCall[] = [];
  const kills: Array<string | undefined> = [];
  const stream = (): FakeChild['stdout'] => {
    const value = new EventEmitter() as FakeChild['stdout'];
    value.setEncoding = () => {};
    return value;
  };
  const child = new EventEmitter() as FakeChild;
  child.stdout = stream();
  child.stderr = stream();
  child.kill = (signal?: string) => {
    kills.push(signal);
    if (options.closeOnKill !== undefined) setImmediate(() => child.emit('close', options.closeOnKill ?? null));
    return true;
  };
  const run = ((command: string, args: string[], spawnOptions: SpawnCall['options']) => {
    calls.push({ command, args, options: spawnOptions });
    return child;
  }) as unknown as SpawnStub;
  return { run, calls, kills, child };
}

describe('encodeCommand', () => {
  it('produces the UTF-16LE base64 payload -EncodedCommand expects', () => {
    expect(encodeCommand('A')).toBe('QQA=');
    const script = "$dest = $env:X\nWrite-Output 'Ünïcode ✓'";
    const decoded = Buffer.from(encodeCommand(script), 'base64');
    expect(decoded.length).toBe(script.length * 2);
    expect(decoded.toString('utf16le')).toBe(script);
  });
});

describe('cleanPowerShellMessage', () => {
  it('unwraps CLIXML error blocks into readable lines', () => {
    const clixml =
      '#< CLIXML\n<Objs Version="1.1.0.1" xmlns="http://schemas.microsoft.com/powershell/2004/04">' +
      "<S S=\"Error\">A file named 'Game.nsp' already exists on the MTP destination._x000D__x000A_</S>" +
      '<S S="Error">MTP &amp; transfer &lt;failed&gt;_x000D__x000A_</S></Objs>';
    // Each block keeps its trailing `_x000D__x000A_` newline, exactly like the
    // Python join that this ports.
    expect(cleanPowerShellMessage(clixml)).toBe(
      "A file named 'Game.nsp' already exists on the MTP destination.\n\nMTP & transfer <failed>",
    );
  });

  it('leaves plain messages untouched', () => {
    expect(cleanPowerShellMessage('  MTP destination is not available: shell:::x  ')).toBe(
      'MTP destination is not available: shell:::x',
    );
  });

  it('falls back to the raw payload when a CLIXML document carries no error text', () => {
    const payload = '#< CLIXML\n<Objs Version="1.1.0.1" />';
    expect(cleanPowerShellMessage(payload)).toBe(payload);
  });
});

describe('readScript', () => {
  it('reads the three programs from the repo scripts directory', () => {
    const list = readScript('mtp-list-storage.ps1', { scriptsDir: REPO_SCRIPTS });
    expect(list).toContain('Normalize-StorageName');
    expect(list.trimEnd().endsWith('$rows | ConvertTo-Json -Compress')).toBe(true);

    const copy = readScript('mtp-copy-file.ps1', { scriptsDir: REPO_SCRIPTS });
    expect(copy).toContain('$env:SWITCH_CATALOG_MTP_DESTINATION');
    expect(copy).toContain('$env:SWITCH_CATALOG_MTP_SOURCE');
    expect(copy).toContain('$env:SWITCH_CATALOG_MTP_TIMEOUT');
    expect(copy).toContain('Wait-ForShellFileOperation');

    const picker = readScript('mtp-pick-folder.ps1', { scriptsDir: REPO_SCRIPTS });
    expect(picker).toContain('$env:SWITCH_CATALOG_MTP_PICKER_TITLE');
  });

  it('refuses names that would escape the scripts directory', () => {
    expect(() => readScript('../../etc/passwd', { scriptsDir: REPO_SCRIPTS })).toThrow(/scripts directory/);
  });

  it('defaults to the development resources directory', () => {
    expect(defaultScriptsDir().endsWith(join('resources', 'scripts'))).toBe(true);
  });
});

describe('runPowerShell', () => {
  it('runs the encoded script with no caller text on the command line', async () => {
    const stub = createSpawnStub();
    const script = "$dest = $env:SWITCH_CATALOG_MTP_DESTINATION\nWrite-Output 'done'";
    const pending = runPowerShell({
      script,
      timeoutMs: 5000,
      env: { SWITCH_CATALOG_MTP_SOURCE: '/tmp/evil & calc.nsp' },
      run: stub.run,
    });
    stub.child.emit('close', 0);
    await expect(pending).resolves.toEqual({ stdout: '', stderr: '', code: 0 });

    expect(stub.calls).toHaveLength(1);
    const call = stub.calls[0];
    expect(call.command).toBe('powershell.exe');
    expect(call.args).toEqual([
      '-NoProfile',
      '-STA',
      '-ExecutionPolicy',
      'Bypass',
      '-EncodedCommand',
      encodeCommand(script),
    ]);
    expect(call.args.join(' ')).not.toContain('evil');
    expect(call.args.join(' ')).not.toContain('SWITCH_CATALOG');
    expect(call.options.windowsHide).toBe(true);
    expect(call.options.env?.SWITCH_CATALOG_MTP_SOURCE).toBe('/tmp/evil & calc.nsp');
  });

  it('returns captured output and the exit code instead of rejecting', async () => {
    const stub = createSpawnStub();
    const pending = runPowerShell({ script: 'exit 1', timeoutMs: 5000, run: stub.run });
    stub.child.stdout.emit('data', 'partial output');
    stub.child.stderr.emit('data', 'boom');
    stub.child.emit('close', 1);
    await expect(pending).resolves.toEqual({ stdout: 'partial output', stderr: 'boom', code: 1 });
  });

  it('kills the process and reports a timeout', async () => {
    const stub = createSpawnStub({ closeOnKill: null });
    const failure = await runPowerShell({ script: 'Start-Sleep 60', timeoutMs: 20, run: stub.run }).catch(
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(PowerShellError);
    expect((failure as PowerShellError).timedOut).toBe(true);
    expect((failure as PowerShellError).code).toBe(-1);
    expect(stub.kills).toHaveLength(1);
    expect(stub.calls[0].args).toContain('-EncodedCommand');
  });

  it('reports PowerShell as unavailable when the binary cannot be started', async () => {
    const stub = createSpawnStub();
    const pending = runPowerShell({ script: 'Get-Date', timeoutMs: 5000, run: stub.run });
    stub.child.emit('error', Object.assign(new Error('spawn powershell.exe ENOENT'), { code: 'ENOENT' }));
    const failure = await pending.catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(PowerShellError);
    expect((failure as PowerShellError).message).toMatch(/PowerShell is unavailable/);
    expect((failure as PowerShellError).spawnError?.message).toContain('ENOENT');
    expect((failure as PowerShellError).timedOut).toBe(false);
  });
});
