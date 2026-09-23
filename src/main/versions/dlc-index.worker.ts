import { parentPort } from 'node:worker_threads';
import { extractDlcParents, extractPatchIds, nameDlcEntries } from './dlc-index';

parentPort?.once('message', async () => {
  try {
    const download = async (name: string): Promise<Record<string,unknown>> => {
      const response = await fetch(`https://raw.githubusercontent.com/blawar/titledb/master/${name}`,
        { signal: AbortSignal.timeout(120_000) });
      if (!response.ok) throw new Error(`TitleDB ${name}: HTTP ${response.status}`);
      return await response.json() as Record<string, unknown>;
    };
    const { parents, patchIds } = await (async () => {
      const cnmts = await download('cnmts.json');
      return { parents:extractDlcParents(cnmts), patchIds:extractPatchIds(cnmts) };
    })();
    const entries = nameDlcEntries(parents,await download('US.en.json'));
    parentPort?.postMessage({ entries, patchIds });
  } catch (error) {
    parentPort?.postMessage({ error: error instanceof Error ? error.message : String(error) });
  }
});
