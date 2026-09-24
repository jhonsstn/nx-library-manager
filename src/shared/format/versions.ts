import type { InstalledStatusDto, UpdateStatusKind, VersionInfoDto, VersionStatusDto } from '../types/domain';

/** Version parsing, formatting, and comparison helpers. */

/** Splits a packed Switch version into major/minor/patch. */
export function rawVersionToDotted(version: number): string {
  const major = Math.floor(version / 65536);
  const minor = Math.floor((version % 65536) / 256);
  const patch = version % 256;
  return `${major}.${minor}.${patch}`;
}

function toInteger(value: number | string): number | null {
  if (typeof value === 'number') return Number.isInteger(value) ? value : null;
  return /^[+-]?\d+$/.test(value.trim()) ? Number.parseInt(value, 10) : null;
}

/** `v65536 (1.0.0)`; non-numeric input is returned as text. */
export function versionLabel(version: number | string): string {
  const value = toInteger(version);
  if (value === null) return String(version);
  return `v${value} (${rawVersionToDotted(value)})`;
}

export function releasedVersionLabel(version: number, releaseDate = ''): string {
  const label = versionLabel(version);
  return releaseDate ? `${label} (${releaseDate})` : label;
}

/** Drops trailing `.0` components beyond the first two. */
export function compactDottedVersion(dotted: string): string {
  const parts = dotted.split('.');
  while (parts.length > 2 && parts[parts.length - 1] === '0') parts.pop();
  return parts.join('.');
}

/**
 * Converts a filename-detected version string into the packed numeric form.
 * Dotted inputs are packed as major/minor/patch; small integers are major versions.
 */
export function rawVersionFromVersionText(text: string): number {
  if (!text) return 0;
  if (text.includes('.')) {
    const parts = text.split('.').map((part) => {
      const value = toInteger(part);
      return value ?? 0;
    });
    const [major = 0, minor = 0, patch = 0] = parts;
    return major * 65536 + minor * 256 + patch;
  }
  const value = toInteger(text);
  if (value === null) return 0;
  if (value !== 0 && value < 65536) return value * 65536;
  return value;
}

/** `" (v65536) (v1.0)"` — the suffix shown beside update file names. */
export function detectedVersionSuffix(detected: string): string {
  if (!detected) return '';
  const raw = rawVersionFromVersionText(detected);
  const dotted = detected.includes('.') ? detected : compactDottedVersion(rawVersionToDotted(raw));
  return ` (v${raw}) (v${dotted})`;
}

export function deriveUpdateStatusKind(
  localVersion: number,
  latest: VersionInfoDto | null,
): UpdateStatusKind {
  if (!latest) return 'unknown';
  if (localVersion <= 0) return 'missing-local-version';
  if (latest.version > localVersion) return 'update-available';
  if (latest.version < localVersion) return 'local-newer';
  return 'current';
}

/** Two-line status text identical to `versions.update_status`'s string output. */
export function formatVersionStatusText(status: Pick<VersionStatusDto, 'localVersion' | 'latest'>): string {
  const onFile = `Latest Version on File: ${versionLabel(status.localVersion)}`;
  if (!status.latest) return `${onFile}\nLatest Version Released: unknown`;
  return `${onFile}\nLatest Version Released: ${releasedVersionLabel(
    status.latest.version,
    status.latest.releaseDate,
  )}`;
}

/** Single-line installed-version text identical to `ui.installed_status_text`'s output. */
export function formatInstalledStatus(installed: InstalledStatusDto | null): string {
  if (!installed) return 'Last app transfer: None';
  const where = installed.destinationLabel || installed.destinationFolder || 'unknown destination';
  return `Last app transfer: ${versionLabel(installed.rawVersion)} | ${where}`;
}
