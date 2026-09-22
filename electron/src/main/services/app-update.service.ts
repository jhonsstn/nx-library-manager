import { RELEASES_API_URL, RELEASES_PAGE_URL } from '../../shared/constants';
import { appError } from '../../shared/errors/app-error';
import type { AppUpdateStatusDto } from '../../shared/types/domain';

const REQUEST_TIMEOUT_MS = 10_000;
const GITHUB_ACCEPT = 'application/vnd.github+json';

/**
 * Numeric runs of the version text, e.g. `v1.0.0-beta.2` -> `[1, 0, 0, 2]`.
 * Port of `switch_catalog/app_updates.py::_version_parts`.
 */
function versionParts(value: string): number[] {
  let cleaned = value.trim().toLowerCase();
  if (cleaned.startsWith('v')) cleaned = cleaned.slice(1);
  const parts = (cleaned.match(/\d+/g) ?? []).map((part) => Number(part));
  return parts.length > 0 ? parts : [0];
}

/** Exact port of `switch_catalog/app_updates.py::is_newer_version`. */
export function isNewerVersion(candidate: string, current: string): boolean {
  const next = versionParts(candidate);
  const installed = versionParts(current);
  const length = Math.max(next.length, installed.length);
  while (next.length < length) next.push(0);
  while (installed.length < length) installed.push(0);
  for (let index = 0; index < length; index += 1) {
    if (next[index] !== installed[index]) return next[index] > installed[index];
  }
  return false;
}

/** Asks GitHub for the latest release and reports whether it is newer. */
export class AppUpdateService {
  private readonly currentVersion: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: { currentVersion: string; fetchImpl?: typeof fetch }) {
    this.currentVersion = options.currentVersion;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async checkLatestRelease(): Promise<AppUpdateStatusDto> {
    let response: Response;
    try {
      response = await this.fetchImpl(RELEASES_API_URL, {
        headers: { Accept: GITHUB_ACCEPT },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (cause) {
      throw appError('UPDATE_CHECK_FAILED', 'Could not reach the release feed.', {
        retryable: true,
        cause,
      });
    }

    if (!response.ok) {
      throw appError('UPDATE_CHECK_FAILED', `GitHub returned HTTP ${response.status}.`, {
        details: { status: response.status },
        retryable: true,
      });
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch (cause) {
      throw appError('UPDATE_CHECK_FAILED', 'The release feed was not valid JSON.', {
        retryable: true,
        cause,
      });
    }

    const release = payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : {};
    const tag = asText(release.tag_name) || asText(release.name);
    if (!tag) {
      throw appError('UPDATE_CHECK_FAILED', 'The latest release did not include a version tag.', {
        retryable: true,
      });
    }

    return {
      currentVersion: this.currentVersion,
      latestVersion: tag,
      releaseName: asText(release.name) || tag || 'Latest release',
      releaseUrl: asText(release.html_url) || RELEASES_PAGE_URL,
      updateAvailable: isNewerVersion(tag, this.currentVersion),
    };
  }
}

/** Mirrors Python's `str(value or "")` for the fields the release payload may omit. */
function asText(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number') return String(value);
  return '';
}
