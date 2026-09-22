import { RELEASES_API_URL, RELEASES_PAGE_URL } from '../../shared/constants';
import { appError } from '../../shared/errors/app-error';
import type { AppUpdateStatusDto } from '../../shared/types/domain';
import semver from 'semver';

const REQUEST_TIMEOUT_MS = 10_000;
const GITHUB_ACCEPT = 'application/vnd.github+json';

export function isNewerVersion(candidate: string, current: string): boolean {
  const normalize = (value: string): string | null => {
    const cleaned = value.trim().replace(/^v/i, '');
    return semver.valid(cleaned) ?? semver.coerce(cleaned)?.version ?? null;
  };
  const next = normalize(candidate);
  const installed = normalize(current);
  if (!next || !installed) return false;
  return semver.gt(next, installed);
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

function asText(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number') return String(value);
  return '';
}
