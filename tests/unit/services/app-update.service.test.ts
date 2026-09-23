import { describe, expect, it } from 'vitest';

import { AppUpdateService, isNewerVersion } from '@main/services/app-update.service';
import { RELEASES_API_URL, RELEASES_PAGE_URL } from '@shared/constants';
import { SwitchCatalogError } from '@shared/errors/app-error';
import type { AppUpdateStatusDto } from '@shared/types/domain';

interface Recorded {
  url: string;
  headers: Record<string, string>;
  signal: unknown;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function stubFetch(response: Response | Error, recorded: Recorded[]): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    recorded.push({
      url: String(input),
      headers: (init?.headers ?? {}) as Record<string, string>,
      signal: init?.signal,
    });
    if (response instanceof Error) throw response;
    return response;
  }) as typeof fetch;
}

function serviceWith(response: Response | Error, currentVersion = '1.0.0'): {
  service: AppUpdateService;
  recorded: Recorded[];
} {
  const recorded: Recorded[] = [];
  return { service: new AppUpdateService({ currentVersion, fetchImpl: stubFetch(response, recorded) }), recorded };
}

async function checkFailure(
  response: Response | Error,
  currentVersion = '1.0.0',
): Promise<SwitchCatalogError> {
  const { service } = serviceWith(response, currentVersion);
  try {
    await service.checkLatestRelease();
    throw new Error('expected the update check to fail');
  } catch (error) {
    expect(error).toBeInstanceOf(SwitchCatalogError);
    return error as SwitchCatalogError;
  }
}

describe('isNewerVersion', () => {
  it.each([
    ['1.1.0', '1.0.0', true],
    ['v1.0.0', '1.0.0', false],
    ['1.0.0', '1.0.10', false],
    ['1.0.10', '1.0.0', true],
    ['1.0.0-beta.1', '1.0.0', false],
    ['1.0.0', '1.0.0-electron-beta.1', true],
    ['2', '1.9.9', true],
    ['1.0.0', '1.0.0', false],
  ])('%s vs %s -> %s', (candidate, current, expected) => {
    expect(isNewerVersion(candidate, current)).toBe(expected);
  });
});

describe('AppUpdateService.checkLatestRelease', () => {
  it('checks releases from this repository', () => {
    expect(RELEASES_API_URL).toBe('https://api.github.com/repos/jhonsstn/switch-game-catalog/releases/latest');
    expect(RELEASES_PAGE_URL).toBe('https://github.com/jhonsstn/switch-game-catalog/releases');
  });

  it('reports a newer release', async () => {
    const { service, recorded } = serviceWith(
      jsonResponse({ tag_name: 'v1.2.0', name: 'Electron beta 2', html_url: 'https://example.test/rel/1.2.0' }),
    );

    const status: AppUpdateStatusDto = await service.checkLatestRelease();

    expect(status).toEqual({
      currentVersion: '1.0.0',
      latestVersion: 'v1.2.0',
      releaseName: 'Electron beta 2',
      releaseUrl: 'https://example.test/rel/1.2.0',
      updateAvailable: true,
    });
    expect(recorded).toHaveLength(1);
    expect(recorded[0].url).toBe(RELEASES_API_URL);
    expect(recorded[0].headers).toEqual({ Accept: 'application/vnd.github+json' });
    expect(recorded[0].signal).toBeInstanceOf(AbortSignal);
  });

  it('reports no update when the release matches the running version', async () => {
    const { service } = serviceWith(jsonResponse({ tag_name: '1.0.0', name: '1.0.0' }));

    const status = await service.checkLatestRelease();

    expect(status.latestVersion).toBe('1.0.0');
    expect(status.updateAvailable).toBe(false);
  });

  it('falls back to the release page and name when the payload omits them', async () => {
    const { service } = serviceWith(jsonResponse({ tag_name: '1.5.0' }));

    const status = await service.checkLatestRelease();

    expect(status.releaseUrl).toBe(RELEASES_PAGE_URL);
    expect(status.releaseName).toBe('1.5.0');
    expect(status.updateAvailable).toBe(true);
  });

  it.each([404, 500])('fails with UPDATE_CHECK_FAILED on HTTP %i', async (status) => {
    const error = await checkFailure(jsonResponse({ message: 'nope' }, status));

    expect(error.code).toBe('UPDATE_CHECK_FAILED');
    expect(error.retryable).toBe(true);
    expect(error.details).toMatchObject({ status });
  });

  it('fails with UPDATE_CHECK_FAILED when the network is unreachable', async () => {
    const error = await checkFailure(new Error('offline'));

    expect(error.code).toBe('UPDATE_CHECK_FAILED');
    expect(error.retryable).toBe(true);
  });

  it('fails with UPDATE_CHECK_FAILED when the payload has no tag', async () => {
    const error = await checkFailure(jsonResponse({ html_url: 'https://example.test/rel' }));

    expect(error.code).toBe('UPDATE_CHECK_FAILED');
    expect(error.retryable).toBe(true);
  });
});
