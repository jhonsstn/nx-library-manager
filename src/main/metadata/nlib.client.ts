import type { AppDatabase } from '../db/database';
import type { MetadataCandidateDto } from '../../shared/types/domain';

const TTL_MS = 24 * 60 * 60 * 1000;
const TITLE_ID = /^[0-9A-F]{16}$/;

export interface NlibRecord extends MetadataCandidateDto {
  nsuId: string | null;
  bannerUrl: string | null;
}
type CachedNlib = { kind: 'hit' | 'missing'; data?: NlibRecord };

function httpsUrl(value: unknown): string {
  if (typeof value !== 'string' || !value) return '';
  const url = value.startsWith('//') ? `https:${value}` : value.replace(/^http:\/\//i, 'https://');
  try { return new URL(url).protocol === 'https:' ? url : ''; } catch { return ''; }
}

export class NlibClient {
  constructor(private readonly db: AppDatabase, private readonly fetchImpl: typeof fetch = fetch,
    private readonly now: () => number = Date.now) {}

  async lookup(titleId: string): Promise<NlibRecord | null> {
    const id = titleId.toUpperCase();
    if (!TITLE_ID.test(id)) return null;
    const cached = this.db.prepare(
      "SELECT response_json, cached_at FROM metadata_cache WHERE provider = 'nlib' AND query = ?",
    ).get(id) as { response_json: string; cached_at: string } | undefined;
    let stored: CachedNlib | null = null;
    try {
      const parsed = cached ? JSON.parse(cached.response_json) as CachedNlib : null;
      stored = parsed?.kind === 'missing' ? parsed
        : parsed?.kind === 'hit' && validCachedHit(parsed.data,id) ? parsed : null;
    } catch { /* retry */ }
    const fresh = cached && this.now() - Date.parse(`${cached.cached_at.replace(' ', 'T')}Z`) < TTL_MS;
    if (fresh && stored) return stored.kind === 'hit' ? stored.data ?? null : null;

    try {
      const response = await this.fetchImpl(`https://api.nlib.cc/nx/${id}?lang=en`, {
        signal: AbortSignal.timeout(20_000), headers: { Accept: 'application/json' },
      });
      if (response.status === 404) {
        this.save(id, { kind: 'missing' });
        return null;
      }
      if (!response.ok) throw new Error(`Nlib HTTP ${response.status}`);
      const raw = await response.json() as Record<string, unknown>;
      const mapped = mapNlibRecord(id, raw);
      if (!mapped) return stored?.kind === 'hit' ? stored.data ?? null : null;
      this.save(id, { kind: 'hit', data: mapped });
      return mapped;
    } catch {
      return stored?.kind === 'hit' ? stored.data ?? null : null;
    }
  }

  private save(id: string, value: unknown): void {
    this.db.prepare(`INSERT INTO metadata_cache(provider, query, response_json, cached_at)
      VALUES ('nlib', ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(provider, query) DO UPDATE SET response_json = excluded.response_json,
        cached_at = CURRENT_TIMESTAMP`).run(id, JSON.stringify(value));
  }
}

function validCachedHit(value: NlibRecord | undefined, id: string): value is NlibRecord {
  return Boolean(value && value.provider === 'nlib' && value.providerId === id
    && typeof value.title === 'string' && value.title.trim()
    && typeof value.description === 'string' && Array.isArray(value.genres));
}

export function mapNlibRecord(titleId: string, raw: Record<string, unknown>): NlibRecord | null {
  const data = raw.data && typeof raw.data === 'object' ? raw.data as Record<string, unknown> : raw;
  const id = String(data.id ?? data.titleId ?? '').toUpperCase();
  const title = String(data.name ?? data.title ?? '').trim();
  if (id !== titleId.toUpperCase() || !title) return null;
  const categories = data.category ?? data.categories;
  const screenRecord = data.screens && typeof data.screens === 'object'
    ? data.screens as Record<string, unknown> : null;
  const screens = screenRecord?.screenshots ?? data.screenshots ?? data.screens;
  const icon = data.icon ?? data.iconUrl;
  const banner = data.banner ?? data.bannerUrl;
  return {
    provider: 'nlib', providerId: id, title,
    description: String(data.description ?? ''),
    publisher: String(data.publisher ?? ''), developer: String(data.developer ?? ''),
    releaseDate: String(data.releaseDate ?? data.release_date ?? ''),
    genres: Array.isArray(categories) ? categories.filter((x): x is string => typeof x === 'string') : [],
    coverImageUrl: httpsUrl(icon), bannerUrl: httpsUrl(banner),
    screenshots: Array.isArray(screens) ? screens.map(httpsUrl).filter(Boolean) : [],
    trailerUrl: '', confidence: 1,
    nsuId: data.nsuId == null ? null : String(data.nsuId),
  };
}
