import { Worker } from 'node:worker_threads';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { inspectPackage, type InspectedTitle } from './package-inspector';

export async function inspectInWorker(path: string, keys: Map<string, Buffer> | null,
  signal: AbortSignal): Promise<InspectedTitle[]> {
  if (signal.aborted) throw new Error('Inspection cancelled');
  const workerPath = join(__dirname, 'package-inspector.worker.js');
  // Vitest runs directly from TypeScript sources before a production build.
  if (!existsSync(workerPath)) return inspectPackage(path,keys,signal);
  return new Promise((resolve, reject) => {
    const worker = new Worker(workerPath);
    let done = false;
    const finish = (error: Error | null, titles?: InspectedTitle[]) => {
      if (done) return;
      done = true;
      signal.removeEventListener('abort', abort);
      void worker.terminate();
      if (error) reject(error);
      else resolve(titles ?? []);
    };
    const abort = () => finish(new Error('Inspection cancelled'));
    signal.addEventListener('abort', abort, { once: true });
    worker.once('error', (error) => finish(error instanceof Error ? error : new Error(String(error))));
    worker.once('exit', (code) => {
      if (!done) finish(new Error(`Inspector exited with code ${code}`));
    });
    worker.once('message', (result: { titles?: InspectedTitle[]; error?: string }) => {
      if (result.error) finish(new Error(result.error));
      else finish(null, result.titles);
    });
    worker.postMessage({ path, keys });
  });
}
