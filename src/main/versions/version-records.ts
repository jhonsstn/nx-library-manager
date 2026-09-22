import type { VersionInfoDto } from '../../shared/types/domain';

/**
 * Pure version-database logic. Ports the record-shaping half of
 * `switch_catalog/versions.py` (`parse_versions_txt`, `_merge_versions`,
 * `latest_for_title`, `_newer_versions`, `_base_id_from_update_id`).
 *
 * A version database maps an uppercase 16-hex-digit title ID to a record of
 * `rawVersion -> releaseDate` entries; version keys are numeric strings so
 * comparisons never fall back to lexicographic order.
 */
export type VersionRecords = Record<string, Record<string, string>>;

const INTEGER_PATTERN = /^[+-]?\d+$/;
/** `int(text, 16)` accepted shapes: optional sign, optional `0x`, hex digits. */
const HEX_PATTERN = /^([+-]?)(?:0[xX])?([0-9a-fA-F]+)$/;
const UPDATE_ID_BIT = 0x800n;

/** Python's `str.splitlines()` boundaries, so `\r`-only files parse identically. */
const LINE_BOUNDARY = /\r\n|[\n\r\v\f\u0085\u2028\u2029]/;

/** Integer parse with Python's `int()` rejection behavior (no decimals, no exponents). */
function toIntegerOrNull(text: string): number | null {
  const trimmed = text.trim();
  return INTEGER_PATTERN.test(trimmed) ? Number.parseInt(trimmed, 10) : null;
}

function formatHex16(value: bigint): string {
  return value.toString(16).toUpperCase().padStart(16, '0');
}

/**
 * Maps an update title ID onto the base title ID it updates by clearing the
 * `0x800` bit. Non-hex input is returned unchanged (`_base_id_from_update_id`).
 */
export function baseIdFromUpdateId(titleId: string): string {
  const match = HEX_PATTERN.exec(titleId.trim());
  if (!match) return titleId;
  let value = BigInt(`0x${match[2]}`);
  if (match[1] === '-') value = -value;
  if ((value & UPDATE_ID_BIT) !== 0n) value -= UPDATE_ID_BIT;
  return formatHex16(value);
}

/**
 * Parses the `id|name|version` table published as `versions.txt`.
 *
 * Lines that are empty or part of the header are skipped, and the maximum
 * version seen wins for both the update ID and its base ID.
 */
export function parseVersionsTxt(text: string): VersionRecords {
  const rows = new Map<string, number>();
  // Python accumulates with `max(rows.get(id, 0), version)`, so the floor is 0.
  const remember = (titleId: string, version: number) => {
    rows.set(titleId, Math.max(rows.get(titleId) ?? 0, version));
  };

  for (const line of text.split(LINE_BOUNDARY)) {
    if (!line || line.startsWith('id|')) continue;
    const parts = line.split('|');
    if (parts.length < 3) continue;
    const titleId = parts[0].trim().toUpperCase();
    const versionText = parts[2].trim();
    if (titleId.length !== 16 || !versionText) continue;
    const version = toIntegerOrNull(versionText);
    if (version === null) continue;
    remember(titleId, version);
    remember(baseIdFromUpdateId(titleId), version);
  }

  const records: VersionRecords = {};
  for (const [titleId, version] of rows) records[titleId] = { [String(version)]: '' };
  return records;
}

/**
 * Merges the JSON and TXT sources. JSON records win; TXT records only fill
 * gaps (`_merge_versions`).
 */
export function mergeVersionRecords(
  jsonVersions: VersionRecords,
  txtVersions: VersionRecords,
): VersionRecords {
  const merged: VersionRecords = {};
  for (const [titleId, records] of Object.entries(jsonVersions)) {
    merged[titleId.toUpperCase()] = { ...records };
  }
  for (const [titleId, records] of Object.entries(txtVersions)) {
    const key = titleId.toUpperCase();
    if (!Object.hasOwn(merged, key)) merged[key] = {};
    const target = merged[key];
    for (const [version, releaseDate] of Object.entries(records)) {
      if (!Object.hasOwn(target, version)) target[version] = releaseDate;
    }
  }
  return merged;
}

/** Records for a title ID, or `null` when unknown/empty (case-insensitive). */
function recordsFor(versions: VersionRecords, titleId: string): Record<string, string> | null {
  const key = titleId.toUpperCase();
  if (!Object.hasOwn(versions, key)) return null;
  const records = versions[key];
  if (typeof records !== 'object' || records === null) return null;
  return Object.keys(records).length > 0 ? records : null;
}

/** Highest known version for a title ID, or `null` when the title is unknown. */
export function latestForTitle(versions: VersionRecords, titleId: string): VersionInfoDto | null {
  const records = recordsFor(versions, titleId);
  if (!records) return null;
  let latest: number | null = null;
  for (const version of Object.keys(records)) {
    const value = toIntegerOrNull(version);
    if (value === null) continue;
    if (latest === null || value > latest) latest = value;
  }
  if (latest === null) return null;
  return { version: latest, releaseDate: records[String(latest)] ?? '' };
}

/** Released versions strictly newer than `current`, newest first. */
export function newerVersions(
  versions: VersionRecords,
  titleId: string,
  current: number,
): VersionInfoDto[] {
  const records = recordsFor(versions, titleId);
  if (!records) return [];
  const newer: VersionInfoDto[] = [];
  for (const [version, releaseDate] of Object.entries(records)) {
    const value = toIntegerOrNull(version);
    if (value === null || value <= current) continue;
    newer.push({ version: value, releaseDate: releaseDate ?? '' });
  }
  return newer.sort((left, right) => right.version - left.version);
}

export interface VersionStatusInputOptions {
  /** Local file versions already converted to packed numbers. */
  localVersions: number[];
  titleId: string;
  versions: VersionRecords;
}

export interface VersionStatusInputResult {
  localVersion: number;
  latest: VersionInfoDto | null;
  newer: VersionInfoDto[];
}

/**
 * Inputs for `deriveUpdateStatusKind` / `formatVersionStatusText`. The status
 * text and enum stay in `shared/format/versions` so every surface renders them
 * identically.
 */
export function versionStatusInput(options: VersionStatusInputOptions): VersionStatusInputResult {
  const { localVersions, titleId, versions } = options;
  const localVersion = localVersions.length ? localVersions.reduce((a, b) => Math.max(a, b)) : 0;
  return {
    localVersion,
    latest: latestForTitle(versions, titleId),
    newer: newerVersions(versions, titleId, localVersion),
  };
}
