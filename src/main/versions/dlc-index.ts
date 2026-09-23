import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';

export interface KnownDlc { titleId: string; baseTitleId: string; name: string | null }
export interface DlcIndex { refreshedAt: string; entries: KnownDlc[]; patchIds: string[] }
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const TITLE_ID = /^[0-9A-F]{16}$/;

export function compileDlcIndex(cnmts: Record<string, unknown>, catalog: Record<string, unknown>): KnownDlc[] {
  return nameDlcEntries(extractDlcParents(cnmts),catalog);
}

export function nameDlcEntries(entries: KnownDlc[], catalog: Record<string, unknown>): KnownDlc[] {
  const names = new Map<string, string>();
  for (const raw of Object.values(catalog)) {
    if (!raw || typeof raw !== 'object') continue;
    const row = raw as Record<string, unknown>;
    const id = String(row.id ?? '').toUpperCase();
    if (TITLE_ID.test(id) && typeof row.name === 'string' && row.name.trim()) names.set(id, row.name.trim());
  }
  return entries.map((entry) => ({ ...entry, name: names.get(entry.titleId) ?? null }));
}

export function extractDlcParents(cnmts: Record<string, unknown>): KnownDlc[] {
  const entries: KnownDlc[] = [];
  for (const [key, versions] of Object.entries(cnmts)) {
    const id = key.toUpperCase();
    if (!TITLE_ID.test(id) || !versions || typeof versions !== 'object') continue;
    const rows = Object.values(versions as Record<string, unknown>);
    const row = rows.find((item) => item && typeof item === 'object' &&
      Number((item as Record<string, unknown>).titleType) === 130) as Record<string, unknown> | undefined;
    if (!row) continue;
    const parent = String(row.otherApplicationId ?? '').toUpperCase();
    if (!TITLE_ID.test(parent) || parent === id) continue;
    entries.push({ titleId: id, baseTitleId: parent, name: null });
  }
  return entries;
}

export function extractPatchIds(cnmts: Record<string, unknown>): string[] {
  const ids: string[] = [];
  for (const [key, versions] of Object.entries(cnmts)) {
    const id = key.toUpperCase();
    if (!TITLE_ID.test(id) || !versions || typeof versions !== 'object') continue;
    if (Object.values(versions as Record<string, unknown>).some((item) => item &&
      typeof item === 'object' && Number((item as Record<string, unknown>).titleType) === 129)) ids.push(id);
  }
  return ids;
}

export class DlcIndexCache {
  private index: DlcIndex | null = null;
  private patches: ReadonlySet<string> | null = null;
  private readonly file: string;
  constructor(cacheDir: string) { this.file = join(cacheDir, 'dlc-index.json'); }

  loadCached(): DlcIndex | null {
    if (!existsSync(this.file)) return null;
    try {
      const value = JSON.parse(readFileSync(this.file, 'utf8')) as DlcIndex;
      if (!value.refreshedAt || !Number.isFinite(Date.parse(value.refreshedAt))
        || !Array.isArray(value.entries) || value.entries.length < 100
        || !value.entries.every((entry) => TITLE_ID.test(entry.titleId)
          && TITLE_ID.test(entry.baseTitleId) && (entry.name === null || typeof entry.name === 'string'))
        || !Array.isArray(value.patchIds) || value.patchIds.length < 100
        || !value.patchIds.every((id) => TITLE_ID.test(id)))
        return null;
      this.index = value;
      this.patches = new Set(value.patchIds);
      return value;
    } catch { return null; }
  }

  get refreshedAt(): string | null { return this.index?.refreshedAt ?? null; }
  get patchIds(): ReadonlySet<string> | null { return this.patches; }

  forBase(baseTitleId: string): KnownDlc[] {
    return this.index?.entries.filter((entry) => entry.baseTitleId === baseTitleId) ?? [];
  }

  async refresh(force = false): Promise<boolean> {
    if (!force && this.index && Date.now() - Date.parse(this.index.refreshedAt) < WEEK_MS) return false;
    const data = await new Promise<{ entries: KnownDlc[]; patchIds: string[] }>((resolve, reject) => {
      const worker = new Worker(join(__dirname, 'dlc-index.worker.js'));
      let settled = false;
      worker.once('message', (result: { entries?: KnownDlc[]; patchIds?: string[]; error?: string }) => {
        settled = true;
        void worker.terminate();
        if (result.error || !result.entries || !result.patchIds) reject(new Error(result.error ?? 'DLC index unavailable'));
        else resolve({ entries: result.entries, patchIds: result.patchIds });
      });
      worker.once('error', (error) => { if (!settled) { settled=true; reject(error); } });
      worker.once('exit', (code) => { if (!settled) {
        settled=true; reject(new Error(`DLC index worker exited ${code}`));
      } });
      worker.postMessage('refresh');
    });
    if (data.entries.length < 1000 || data.patchIds.length < 1000) throw new Error('TitleDB index failed validation');
    const next = { refreshedAt: new Date().toISOString(), ...data };
    const temp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(temp, JSON.stringify(next));
    renameSync(temp, this.file);
    this.index = next;
    this.patches = new Set(next.patchIds);
    return true;
  }
}
