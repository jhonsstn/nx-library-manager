import { dirname, extname, resolve } from 'node:path';

/** The database sits beside the executable, or beside the .app bundle on macOS. */
export function resolveDatabaseRoot(input: {
  isPackaged: boolean;
  appPath: string;
  executablePath: string;
  platform: NodeJS.Platform;
  portableExecutableDir?: string;
  developmentOverride?: string;
}): string {
  if (!input.isPackaged) return resolve(input.developmentOverride ?? input.appPath);
  if (input.platform === 'win32' && input.portableExecutableDir?.trim())
    return resolve(input.portableExecutableDir);

  const executableDir = dirname(resolve(input.executablePath));
  if (input.platform !== 'darwin') return executableDir;

  let current = executableDir;
  while (current !== dirname(current)) {
    if (extname(current).toLowerCase() === '.app') return dirname(current);
    current = dirname(current);
  }
  return executableDir;
}
