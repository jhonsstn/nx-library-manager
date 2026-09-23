import { sequenceMatcherRatio } from '../../shared/text/similarity';

/**
 * Pure ports of the title-normalization helpers in `switch_catalog/metadata.py`.
 *
 * These run before every IGDB search and on every candidate name, so the
 * confidence scores remain stable across searches.
 */

/**
 * Characters folded before matching. Keys are the exotic
 * codepoints, values their ASCII equivalent.
 */
const TITLE_REPLACEMENTS: Record<string, string> = {
  '\uA789': ':', // MODIFIER LETTER COLON
  '\uFF1A': ':', // FULLWIDTH COLON
  '\u2013': '-', // EN DASH
  '\u2014': '-', // EM DASH
  '\u2019': "'", // RIGHT SINGLE QUOTATION MARK
  '\u201C': '"', // LEFT DOUBLE QUOTATION MARK
  '\u201D': '"', // RIGHT DOUBLE QUOTATION MARK
  '\u2122': '', // TRADE MARK SIGN
  '\u00AE': '', // REGISTERED SIGN
  '\u00A9': '', // COPYRIGHT SIGN
};

const BRACKETED = /\[[^\]]+\]/g;
const WHITESPACE = /\s+/g;
const ARTICLES = /\b(the|a|an)\b/gi;
const TRIM_CHARS = /^[\-: ]+|[\-: ]+$/g;

/** Ports `normalize_metadata_title`: fold punctuation, drop `[title id]` tags. */
export function normalizeMetadataTitle(title: string): string {
  let value = title.trim();
  for (const [source, target] of Object.entries(TITLE_REPLACEMENTS)) {
    value = value.split(source).join(target);
  }
  return value.replace(BRACKETED, ' ').replace(WHITESPACE, ' ').trim();
}

/**
 * Ports `metadata_search_queries`: the exact title first, then progressively
 * looser variants (subtitle flattened or dropped, leading articles removed).
 */
export function metadataSearchQueries(title: string): string[] {
  const normalized = normalizeMetadataTitle(title);
  const candidates = [normalized];
  if (normalized.includes(':')) {
    const index = normalized.indexOf(':');
    const head = normalized.slice(0, index).trim();
    const tail = normalized.slice(index + 1).trim();
    if (head && tail) candidates.push(`${head} ${tail}`);
    if (head) candidates.push(head);
  }
  candidates.push(normalized.replace(ARTICLES, ' '));

  const deduped: string[] = [];
  const seen = new Set<string>();
  for (const raw of candidates) {
    const candidate = raw.replace(WHITESPACE, ' ').replace(TRIM_CHARS, '');
    const key = candidate.toLowerCase();
    if (candidate && !seen.has(key)) {
      seen.add(key);
      deduped.push(candidate);
    }
  }
  return deduped;
}

/**
 * Ports `_title_similarity`: identical, then prefix, then Gestalt ratio.
 * Confidence is stored on every candidate, so the range stays `[0, 1]`.
 */
export function titleSimilarity(left: string, right: string): number {
  const leftNorm = normalizeMetadataTitle(left).toLowerCase();
  const rightNorm = normalizeMetadataTitle(right).toLowerCase();
  if (!leftNorm || !rightNorm) return 0;
  if (leftNorm === rightNorm) return 1;
  if (leftNorm.startsWith(rightNorm) || rightNorm.startsWith(leftNorm)) return 0.9;
  return sequenceMatcherRatio(leftNorm, rightNorm);
}

/** Ports `_escape_igdb_query`: backslashes first, then double quotes. */
export function escapeIgdbQuery(query: string): string {
  return query.split('\\').join('\\\\').split('"').join('\\"');
}
