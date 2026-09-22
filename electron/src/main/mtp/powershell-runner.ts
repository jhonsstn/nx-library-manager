import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/** Raw result of one PowerShell invocation; `code` is `-1` when never started. */
export interface PowerShellResult {
  stdout: string;
  stderr: string;
  code: number;
}

export interface PowerShellFailureDetails extends PowerShellResult {
  /** True when the runner killed the process because the deadline passed. */
  timedOut: boolean;
  /** Populated when the process could not be spawned (`ENOENT`, `EPERM`, ...). */
  spawnError: Error | null;
}

/**
 * Thrown for timeouts, aborts and spawn failures. Non-zero exits are NOT thrown:
 * callers decide how to report the script's own error message.
 */
export class PowerShellError extends Error {
  readonly timedOut: boolean;
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly spawnError: Error | null;

  constructor(message: string, details: PowerShellFailureDetails) {
    super(message);
    this.name = 'PowerShellError';
    this.timedOut = details.timedOut;
    this.code = details.code;
    this.stdout = details.stdout;
    this.stderr = details.stderr;
    this.spawnError = details.spawnError;
  }
}

export type PowerShellSpawn = typeof spawn;

export interface PowerShellRunOptions {
  /** Script body. Encoded to UTF-16LE base64; never placed on the command line. */
  script: string;
  /** Extra environment variables carrying the script's inputs. */
  env?: Record<string, string>;
  /** Milliseconds before the child is killed. `0` disables the deadline. */
  timeoutMs: number;
  signal?: AbortSignal;
  /** Test seam; defaults to `child_process.spawn`. */
  run?: PowerShellSpawn;
}

export interface ScriptReadOptions {
  /** Overrides the resolved scripts directory (used by tests and packaging). */
  scriptsDir?: string;
}

/**
 * Scripts resolve next to the packaged resources in a build
 * (`resourcesPath/scripts`) and from the project root during development.
 */
export function defaultScriptsDir(): string {
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  if (typeof resourcesPath === 'string' && resourcesPath.length > 0) {
    const packaged = join(resourcesPath, 'scripts');
    if (existsSync(packaged)) return packaged;
  }
  return resolve(process.cwd(), 'resources', 'scripts');
}

export function readScript(fileName: string, options: ScriptReadOptions = {}): string {
  if (!/^[\w.-]+\.ps1$/.test(fileName)) {
    throw new Error(`Refusing to read a PowerShell script outside the scripts directory: ${fileName}`);
  }
  const dir = options.scriptsDir ?? defaultScriptsDir();
  return readFileSync(join(dir, fileName), 'utf8');
}

/**
 * `-EncodedCommand` payload: UTF-16LE base64, exactly like the Qt build used.
 * This is what keeps script text off the argv surface entirely.
 */
export function encodeCommand(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64');
}

function stripXmlText(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

/**
 * Ports `_clean_powershell_message`/`_strip_xml_text`: PowerShell writes
 * non-interactive errors as a CLIXML document with `_x000D__x000A_` newlines,
 * which must be turned back into readable lines before reaching the UI.
 */
export function cleanPowerShellMessage(output: string): string {
  const message = String(output ?? '').trim();
  if (!message.startsWith('#< CLIXML')) return message;
  const decoded = message.replace(/_x000D__x000A_/g, '\n');
  const errors = Array.from(decoded.matchAll(/<S S="Error">([\s\S]*?)<\/S>/g)).map((match) => match[1]);
  if (errors.length === 0) return message;
  return errors.map(stripXmlText).join('\n').trim();
}

/**
 * Runs one script through `powershell.exe -NoProfile -STA -ExecutionPolicy Bypass
 * -EncodedCommand <base64>`. Caller inputs travel through the environment, so
 * nothing user-supplied ever reaches the command line (spec 14/04).
 */
export function runPowerShell(options: PowerShellRunOptions): Promise<PowerShellResult> {
  const timeoutMs = Number.isFinite(options.timeoutMs) ? Math.max(0, Math.floor(options.timeoutMs)) : 0;
  const argv = ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encodeCommand(options.script)];

  return new Promise<PowerShellResult>((resolveRun, rejectRun) => {
    if (options.signal?.aborted) {
      rejectRun(
        new PowerShellError('PowerShell command was cancelled before it started.', {
          stdout: '',
          stderr: '',
          code: -1,
          timedOut: false,
          spawnError: null,
        }),
      );
      return;
    }

    const spawnImpl = options.run ?? spawn;
    let child: ChildProcess;
    try {
      child = spawnImpl('powershell.exe', argv, {
        env: { ...process.env, ...(options.env ?? {}) },
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      rejectRun(toSpawnFailure(error));
      return;
    }

    let stdout = '';
    let stderr = '';
    let settled = false;
    let timer: NodeJS.Timeout | null = null;

    /** Claims the single settlement slot; the second caller becomes a no-op. */
    function claim(): boolean {
      if (settled) return false;
      settled = true;
      if (timer) clearTimeout(timer);
      timer = null;
      options.signal?.removeEventListener('abort', onAbort);
      return true;
    }

    function fail(error: PowerShellError): void {
      if (claim()) rejectRun(error);
    }

    function onAbort(): void {
      child.kill();
      fail(
        new PowerShellError('PowerShell command was cancelled.', {
          stdout,
          stderr,
          code: -1,
          timedOut: false,
          spawnError: null,
        }),
      );
    }

    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      stderr += chunk;
    });

    child.on('error', (error: Error) => {
      const code = (error as NodeJS.ErrnoException).code;
      const message =
        code === 'ENOENT'
          ? 'PowerShell is unavailable: powershell.exe was not found on this system.'
          : `PowerShell could not be started: ${error.message}`;
      fail(new PowerShellError(message, { stdout, stderr, code: -1, timedOut: false, spawnError: error }));
    });

    child.on('close', (code: number | null) => {
      if (claim()) resolveRun({ stdout, stderr, code: code ?? -1 });
    });

    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        child.kill();
        fail(
          new PowerShellError(`PowerShell timed out after ${timeoutMs} ms.`, {
            stdout,
            stderr,
            code: -1,
            timedOut: true,
            spawnError: null,
          }),
        );
      }, timeoutMs);
      timer.unref();
    }

    options.signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function toSpawnFailure(error: unknown): PowerShellError {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  const cause = error instanceof Error ? error : new Error(String(error));
  return new PowerShellError(
    code === 'ENOENT'
      ? 'PowerShell is unavailable: powershell.exe was not found on this system.'
      : `PowerShell could not be started: ${cause.message}`,
    { stdout: '', stderr: '', code: -1, timedOut: false, spawnError: cause },
  );
}
