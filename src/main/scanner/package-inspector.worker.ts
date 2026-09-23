import { parentPort } from 'node:worker_threads';
import { inspectPackage } from './package-inspector';

parentPort?.on('message', async (input: { path: string; keys: Map<string, Uint8Array> | null }) => {
  try {
    const keys = input.keys ? new Map([...input.keys].map(([name,value]) => [name,Buffer.from(value)])) : null;
    const titles = await inspectPackage(input.path, keys);
    parentPort?.postMessage({ titles });
  } catch (error) {
    parentPort?.postMessage({ error: error instanceof Error ? error.message : String(error) });
  }
});
