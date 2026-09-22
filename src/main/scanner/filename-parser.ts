import { SUPPORTED_FILE_EXTENSIONS } from '../../shared/constants';
import { rawVersionFromVersionText } from '../../shared/format/versions';

/**
 * Port of `switch_catalog/filename.py`.
 *
 * Everything here is a pure string transform: the Python original uses
 * `pathlib.Path(name).stem` only to drop the extension, so the functions accept
 * a bare file name (or path) and never touch the filesystem.
 *
 * Two deliberate deviations, both verified against the Python original:
 *
 * - `\` is treated as a path separator (Windows `pathlib` behaviour) instead of
 *   being part of the stem, so paths behave the same on every platform;
 * - case mapping uses the JavaScript engine's Unicode tables (Unicode 17) rather
 *   than the ones CPython ships with (Unicode 16). A differential run over every
 *   codepoint agrees with `str.title()`/`str.islower()` except for characters the
 *   two versions disagree about (Beria Erfe, newly assigned Latin Extended
 *   letters), digraphs whose titlecase mapping differs from their uppercase
 *   mapping (`ǳ` → `ǲ` in Python, `Ǳ` here), multi-character titlecase
 *   expansions (`ß` → `Ss` in Python, `SS` here) and scripts CPython has no
 *   titlecase mapping for (Georgian Mtavruli). None occur in catalog file names.
 */

/** Extensions the catalog recognises, re-exported from the shared constants. */
export const SUPPORTED_EXTENSIONS: readonly string[] = SUPPORTED_FILE_EXTENSIONS;

const REGION_WORDS: Record<string, true> = {
  usa: true,
  us: true,
  eur: true,
  europe: true,
  japan: true,
  jp: true,
  asia: true,
  world: true,
  global: true,
};

const SCENE_WORDS: Record<string, true> = {
  nsw: true,
  eshop: true,
  rev: true,
  repack: true,
  proper: true,
  multi: true,
  dlc: true,
};

/**
 * `\b(?:update\s*)?v?(\d+(?:\.\d+){1,3}|\d{4,})\b` — `detect_version`'s last resort and
 * `clean_title`'s version stripper. Python's `re.sub` replaces every match, hence the `_G` twin.
 */
const VERSION_RE = /\b(?:update\s*)?v?(\d+(?:\.\d+){1,3}|\d{4,})\b/i;
const VERSION_RE_G = new RegExp(VERSION_RE.source, 'gi');

/** `[\[(]v(\d+(?:\.\d+){0,3})[\])]` — highest-precedence version source. */
const BRACKET_VERSION_RE = /[\[(]v(\d+(?:\.\d+){0,3})[\])]/i;

/** `\bupdate\s+v?(\d+(?:\.\d+){0,3})\b` — second precedence. */
const UPDATE_VERSION_RE = /\bupdate\s+v?(\d+(?:\.\d+){0,3})\b/i;

/** `[\[(][^\])]*[\])]` — one bracketed metadata group. */
const BRACKET_RE = /[\[(][^\])]*[\])]/;
const BRACKET_RE_G = new RegExp(BRACKET_RE.source, 'g');

/** `\b0100[0-9a-f]{12}\b` — a 16 character Switch title ID. */
const TITLE_ID_RE = /\b0100[0-9a-f]{12}\b/i;
const TITLE_ID_RE_G = new RegExp(TITLE_ID_RE.source, 'gi');

const UPDATE_OR_DLC_WORD_RE = /\b(?:update|dlc)\b/i;
const UPDATE_WORD_RE_G = /\bupdate\b/gi;
const UPDATE_TAIL_RE_G = /\b(?:update|dlc)\b.*$/gi;

/** `\b\d{4,}\b` — bare years / version runs left in a title by `clean_title`. */
const BARE_NUMBER_RE_G = /\b\d{4,}\b/g;

/** Bracket groups or word runs, matched in document order for `markers`. */
const MARKER_TOKEN_RE = /[\[(][^\])]*[\])]|[\p{L}\p{N}]+/gu;

/**
 * Python's cased/upper/lower classification.
 *
 * Note these are *not* `str.islower()`/`str.isupper()`: CPython's `islower()` is
 * false when any character is uppercase or titlecase (`Lt`), and true only when
 * at least one lowercase character is present, while `str.title()`'s state
 * machine keys off "cased" (lowercase, uppercase or titlecase).
 */
const UPPERCASE_RE = /[\p{Uppercase}\p{Lt}]/u;
const LOWERCASE_RE = /\p{Lowercase}/u;
const CASED_RE = /\p{Cased}/u;

export type SupportedExtension = 'nsp' | 'nsz' | 'xci';

export interface ParsedSwitchFilename {
  originalName: string;
  /** Lowercased extension without the leading dot; a `SupportedExtension` for recognised files. */
  extension: SupportedExtension | string;
  normalizedTitle: string;
  titleId?: string;
  rawVersion?: string;
  versionNumber?: number;
  /** Metadata markers found in the name, lowercase and de-duplicated, in document order. */
  markers: string[];
  probableKind: 'base' | 'update' | 'dlc' | 'unknown';
}

/**
 * `pathlib.Path(name).stem`: the last path segment without its suffix. A leading
 * dot does not start a suffix (`.nsp` keeps its name) and a trailing dot is kept
 * (`a.` → `a.`), exactly like CPython's `PurePath.stem`.
 */
function pathStem(fileName: string): string {
  const slash = Math.max(fileName.lastIndexOf('/'), fileName.lastIndexOf('\\'));
  const base = slash >= 0 ? fileName.slice(slash + 1) : fileName;
  const dot = base.lastIndexOf('.');
  return 0 < dot && dot < base.length - 1 ? base.slice(0, dot) : base;
}

/** `pathlib.Path(name).suffix`, lowercased (`''` when there is none). */
function pathSuffix(fileName: string): string {
  const slash = Math.max(fileName.lastIndexOf('/'), fileName.lastIndexOf('\\'));
  const base = slash >= 0 ? fileName.slice(slash + 1) : fileName;
  const dot = base.lastIndexOf('.');
  return 0 < dot && dot < base.length - 1 ? base.slice(dot) : '';
}

/** Collapses every whitespace run, mirroring Python's `" ".join(text.split())`. */
function collapseWhitespace(value: string): string {
  const trimmed = value.trim();
  return trimmed ? trimmed.split(/\s+/).join(' ') : '';
}

/**
 * Python's `str.title()`: uppercase the first cased character of each word and
 * lowercase the rest. Only the case-mapping data differs (see the module doc:
 * `ß` becomes `Ss` in CPython and `SS` here); the state machine is the same.
 */
function pythonTitle(value: string): string {
  let previousIsCased = false;
  let result = '';
  for (const char of value) {
    if (!CASED_RE.test(char)) {
      previousIsCased = false;
      result += char;
      continue;
    }
    result += previousIsCased ? char.toLowerCase() : char.toUpperCase();
    previousIsCased = true;
  }
  return result;
}

/** Python's `str.islower()`: at least one lowercase character and no uppercase/titlecase one. */
function pythonIsLower(value: string): boolean {
  if (UPPERCASE_RE.test(value)) return false;
  return LOWERCASE_RE.test(value);
}

/** `detect_version`: bracketed version, then `update vN`, then any version-looking run. */
export function detectVersion(fileName: string): string {
  const stem = pathStem(fileName).replace(/_/g, ' ');

  const bracketed = BRACKET_VERSION_RE.exec(stem);
  if (bracketed) return bracketed[1];

  const update = UPDATE_VERSION_RE.exec(stem);
  if (update) return update[1];

  const generic = VERSION_RE.exec(stem);
  return generic ? generic[1] : '';
}

/** `extract_title_id`: the first valid `0100xxxxxxxxxxxx` identifier, uppercased. */
export function extractTitleId(fileName: string): string {
  const match = TITLE_ID_RE.exec(fileName);
  return match ? match[0].toUpperCase() : '';
}

/** `title_id_family`: the leading 12 characters that identify a game's title-ID group. */
export function titleIdFamily(fileName: string): string {
  const titleId = extractTitleId(fileName);
  return titleId ? titleId.slice(0, 12) : '';
}

/**
 * Low 12 bits of the title ID — the content type. Read from the last three hex
 * digits instead of `parseInt(hex, 16)`: a 16 digit ID exceeds `Number`'s 53 bit
 * integer range, and `& 0xFFF` on the rounded double would not be exact.
 */
function titleIdContentType(titleId: string): number {
  return Number.parseInt(titleId.slice(-3), 16);
}

/**
 * The DLC half of `ui._update_file_group`, shared with `classify-file` so the two
 * modules stay acyclic: `dlc` anywhere in the stem, or a title ID whose content
 * type is neither 0 (base) nor `0x800` (update).
 */
export function isDlcGroupFilename(fileName: string): boolean {
  if (pathStem(fileName).toLowerCase().includes('dlc')) return true;

  const titleId = extractTitleId(fileName);
  if (!titleId) return false;
  const contentType = titleIdContentType(titleId);
  return contentType !== 0 && contentType !== 0x800;
}

/** `is_update_or_dlc_filename`: an `update`/`dlc` word, or a non-base/non-update title ID. */
export function isUpdateOrDlcFilename(fileName: string): boolean {
  if (UPDATE_OR_DLC_WORD_RE.test(pathStem(fileName))) return true;

  const titleId = extractTitleId(fileName);
  if (!titleId) return false;
  return titleIdContentType(titleId) !== 0;
}

export interface CleanTitleOptions {
  /** `for_update=True`: drop the `update` word but keep everything that follows it. */
  forUpdate?: boolean;
}

/** `clean_title`: strips version/bracket/punctuation noise, regions and scene words. */
export function cleanTitle(fileName: string, options: CleanTitleOptions = {}): string {
  const forUpdate = options.forUpdate === true;
  let name = pathStem(fileName);

  name = name.replace(VERSION_RE_G, ' ');
  name = name.replace(/\./g, ' ').replace(/_/g, ' ').replace(/-/g, ' ');
  name = name.replace(TITLE_ID_RE_G, ' ');
  name = name.replace(BRACKET_RE_G, ' ');
  name = name.replace(BARE_NUMBER_RE_G, ' ');
  name = name.replace(forUpdate ? UPDATE_WORD_RE_G : UPDATE_TAIL_RE_G, ' ');

  const words: string[] = [];
  for (const rawWord of name.split(/\s+/)) {
    const word = rawWord.trim();
    if (!word) continue;
    const lowered = word.toLowerCase();
    if (Object.hasOwn(REGION_WORDS, lowered) || Object.hasOwn(SCENE_WORDS, lowered)) continue;
    words.push(word);
  }

  const cleaned = collapseWhitespace(words.join(' '));
  return pythonIsLower(cleaned) ? pythonTitle(cleaned) : cleaned;
}

/** Case-insensitive extension test against `SUPPORTED_EXTENSIONS`. */
export function isSupportedExtension(fileName: string): boolean {
  return SUPPORTED_EXTENSIONS.includes(pathSuffix(fileName).toLowerCase());
}

/**
 * Metadata markers present in the name, lowercase and de-duplicated, in document
 * order: region/scene/`update`/`dlc` words plus every non-title-ID bracket group
 * (`[v131072]` → `v131072`, `(En,Fr,De)` → `en,fr,de`).
 */
function collectMarkers(fileName: string): string[] {
  const markers: string[] = [];
  const seen = new Set<string>();
  const push = (value: string): void => {
    const marker = collapseWhitespace(value).toLowerCase();
    if (!marker || seen.has(marker)) return;
    seen.add(marker);
    markers.push(marker);
  };

  for (const match of pathStem(fileName).matchAll(MARKER_TOKEN_RE)) {
    const token = match[0];
    const isBracket = token.startsWith('[') || token.startsWith('(');
    if (isBracket) {
      const inner = token.slice(1, -1);
      if (!TITLE_ID_RE.test(inner)) push(inner);
      continue;
    }
    const lowered = token.toLowerCase();
    if (Object.hasOwn(REGION_WORDS, lowered) || Object.hasOwn(SCENE_WORDS, lowered)) push(lowered);
  }
  return markers;
}

/** Classifies one file name for the scan pipeline. */
export function parseSwitchFilename(fileName: string): ParsedSwitchFilename {
  const rawVersion = detectVersion(fileName);
  const titleId = extractTitleId(fileName);
  const supported = isSupportedExtension(fileName);

  let probableKind: ParsedSwitchFilename['probableKind'] = 'unknown';
  if (supported) {
    if (!isUpdateOrDlcFilename(fileName)) probableKind = 'base';
    else probableKind = isDlcGroupFilename(fileName) ? 'dlc' : 'update';
  }

  const parsed: ParsedSwitchFilename = {
    originalName: fileName,
    extension: pathSuffix(fileName).slice(1).toLowerCase(),
    normalizedTitle: cleanTitle(fileName),
    markers: collectMarkers(fileName),
    probableKind,
  };
  if (titleId) parsed.titleId = titleId;
  if (rawVersion) {
    parsed.rawVersion = rawVersion;
    parsed.versionNumber = rawVersionFromVersionText(rawVersion);
  }
  return parsed;
}
