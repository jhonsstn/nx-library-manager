import { describe, expect, it } from 'vitest';

import {
  baseIdFromUpdateId,
  latestForTitle,
  mergeVersionRecords,
  newerVersions,
  parseVersionsTxt,
  versionStatusInput,
} from '@main/versions/version-records';
import { rawVersionFromVersionText, versionLabel } from '@shared/format/versions';
import type { VersionInfoDto } from '@shared/types/domain';

import fixture from '../../fixtures/legacy/behavior.json';

/**
 * Mirrors `scripts/capture-fixtures.py` so these inputs line up with the
 * captured legacy outputs in `behavior.json`.
 */
const VERSIONS_TXT_SAMPLE = [
  'id|name|version',
  '0100000000010800|Super Mario Odyssey Update|131072',
  '0100000000010000|Super Mario Odyssey|65536',
  '0100A3A0149EC800|Hades Update|262144',
  'not-a-title-id|Ignored|1',
  '0100000000010800|Super Mario Odyssey Update|262144',
].join('\n');

const VERSIONS_JSON_SAMPLE: Record<string, Record<string, string>> = {
  '0100000000010000': { '0': '2017-03-03', '65536': '2017-05-01', '131072': '2018-01-01' },
  '0100A3A0149EC000': { '0': '2020-09-17', '131072': '2021-01-01' },
};

const parsedTxt = parseVersionsTxt(VERSIONS_TXT_SAMPLE);

describe('parseVersionsTxt', () => {
  it('matches the captured legacy output', () => {
    expect(parsedTxt).toEqual(fixture.versions.parseVersionsTxt);
  });

  it('maps an update ID onto its base ID keeping the highest version seen', () => {
    expect(parsedTxt['0100000000010800']).toEqual({ '262144': '' });
    expect(parsedTxt['0100000000010000']).toEqual({ '262144': '' });
    expect(parsedTxt['0100A3A0149EC800']).toEqual({ '262144': '' });
    expect(parsedTxt['0100A3A0149EC000']).toEqual({ '262144': '' });
  });

  it('skips the header, blank lines, short rows, bad IDs and unparsable versions', () => {
    const text = [
      'id|rightsId|version',
      '',
      '0100000000000000|only-two-parts',
      'not-a-title-id|Ignored|1',
      '0100000000000000|Blank version|',
      '0100000000000000|Decimal version|1.5',
      '0100000000000000|Kept|196608',
    ].join('\n');

    expect(parseVersionsTxt(text)).toEqual({ '0100000000000000': { '196608': '' } });
  });

  it('keeps a zero version and normalizes whitespace and case', () => {
    const text = [' 0100a3a0149ec800 |Hades Update| 131072 ', '0100000000000000|Game|0'].join('\n');

    expect(parseVersionsTxt(text)).toEqual({
      '0100A3A0149EC800': { '131072': '' },
      '0100A3A0149EC000': { '131072': '' },
      '0100000000000000': { '0': '' },
    });
  });

  it('returns no records for text without usable rows', () => {
    expect(parseVersionsTxt('')).toEqual({});
    expect(parseVersionsTxt('id|rightsId|version\n')).toEqual({});
  });

  it('floors a negative version at zero like the legacy accumulator', () => {
    expect(parseVersionsTxt('0100000000000000|Game|-5')).toEqual({
      '0100000000000000': { '0': '' },
    });
  });
});

describe('baseIdFromUpdateId', () => {
  it('clears the 0x800 update bit', () => {
    expect(baseIdFromUpdateId('0100A3A0149EC800')).toBe('0100A3A0149EC000');
    expect(baseIdFromUpdateId('0100000000010800')).toBe('0100000000010000');
  });

  it('leaves IDs without the update bit alone', () => {
    expect(baseIdFromUpdateId('0100A3A0149EC000')).toBe('0100A3A0149EC000');
    expect(baseIdFromUpdateId('0100000000010400')).toBe('0100000000010400');
  });

  it('round-trips through the update ID and back', () => {
    for (const titleId of Object.keys(fixture.versions.parseVersionsTxt)) {
      expect(baseIdFromUpdateId(baseIdFromUpdateId(titleId))).toBe(baseIdFromUpdateId(titleId));
    }
    expect(baseIdFromUpdateId(baseIdFromUpdateId('0100A3A0149EC800'))).toBe('0100A3A0149EC000');
  });

  it('returns non-hex input unchanged', () => {
    expect(baseIdFromUpdateId('not-a-title-id')).toBe('not-a-title-id');
    expect(baseIdFromUpdateId('')).toBe('');
    expect(baseIdFromUpdateId('0100A3A0149EC00G')).toBe('0100A3A0149EC00G');
  });

  it('stays exact for 64-bit IDs (no float rounding)', () => {
    expect(baseIdFromUpdateId('FF00A3A0149EC801')).toBe('FF00A3A0149EC001');
  });
});

describe('mergeVersionRecords', () => {
  it('yields the captured merged title IDs from the parsed TXT records alone', () => {
    expect(Object.keys(mergeVersionRecords({}, parsedTxt)).sort()).toEqual(fixture.versions.mergedTitleIds);
  });

  it('yields the captured merged title IDs when JSON records are present', () => {
    const merged = mergeVersionRecords(VERSIONS_JSON_SAMPLE, parsedTxt);
    expect(Object.keys(merged).sort()).toEqual(fixture.versions.mergedTitleIds);
  });

  it('lets JSON records win and fills gaps from TXT', () => {
    const merged = mergeVersionRecords(VERSIONS_JSON_SAMPLE, parsedTxt);

    expect(merged['0100000000010000']).toEqual({
      '0': '2017-03-03',
      '65536': '2017-05-01',
      '131072': '2018-01-01',
      '262144': '',
    });
    expect(merged['0100A3A0149EC000']).toEqual({
      '0': '2020-09-17',
      '131072': '2021-01-01',
      '262144': '',
    });
    expect(merged['0100A3A0149EC800']).toEqual({ '262144': '' });
  });

  it('uppercases keys and does not mutate its inputs', () => {
    const jsonVersions = { '0100a3a0149ec000': { '65536': '2019-01-01' } };
    const txtVersions = { '0100A3A0149EC000': { '65536': '1999-09-09', '131072': '2021-01-01' } };
    const merged = mergeVersionRecords(jsonVersions, txtVersions);

    expect(merged).toEqual({
      '0100A3A0149EC000': { '65536': '2019-01-01', '131072': '2021-01-01' },
    });
    expect(jsonVersions['0100a3a0149ec000']).toEqual({ '65536': '2019-01-01' });
  });
});

describe('latestForTitle', () => {
  it('returns null for unknown or empty title IDs', () => {
    expect(latestForTitle({}, '0100A3A0149EC000')).toBeNull();
    expect(latestForTitle(VERSIONS_JSON_SAMPLE, '0100A3A0149EC001')).toBeNull();
    expect(latestForTitle({ '0100A3A0149EC000': {} }, '0100A3A0149EC000')).toBeNull();
    expect(latestForTitle(mergeVersionRecords(VERSIONS_JSON_SAMPLE, {}), 'constructor')).toBeNull();
  });

  it('picks the numeric maximum, not the lexicographic one', () => {
    expect(latestForTitle({ '0100000000000000': { '9': 'a', '10': 'b' } }, '0100000000000000')).toEqual({
      version: 10,
      releaseDate: 'b',
    });
    expect(
      latestForTitle(
        { '0100000000000000': { '65536': '2019-01-01', '131072': '2020-01-01' } },
        '0100000000000000',
      ),
    ).toEqual({ version: 131072, releaseDate: '2020-01-01' });
  });

  it('looks title IDs up case-insensitively', () => {
    expect(latestForTitle(VERSIONS_JSON_SAMPLE, '0100a3a0149ec000')).toEqual({
      version: 131072,
      releaseDate: '2021-01-01',
    });
  });

  it('reports an empty release date when the record has none', () => {
    expect(latestForTitle({ '0100000000000000': { '196608': '' } }, '0100000000000000')).toEqual({
      version: 196608,
      releaseDate: '',
    });
  });
});

describe('newerVersions', () => {
  const versions = {
    '0100000000000000': {
      '0': '2017-03-03',
      '65536': '2019-01-01',
      '131072': '2020-01-01',
      '196608': '2020-03-01',
    },
  };

  it('lists strictly newer versions newest first', () => {
    expect(newerVersions(versions, '0100000000000000', 65536)).toEqual([
      { version: 196608, releaseDate: '2020-03-01' },
      { version: 131072, releaseDate: '2020-01-01' },
    ]);
  });

  it('excludes the current version and older ones', () => {
    expect(newerVersions(versions, '0100000000000000', 196608)).toEqual([]);
    expect(newerVersions(versions, '0100000000000000', 999999)).toEqual([]);
  });

  it('returns every version for a title with no local version', () => {
    expect(newerVersions(versions, '0100000000000000', 0).map((item) => item.version)).toEqual([
      196608, 131072, 65536,
    ]);
  });

  it('returns nothing for an unknown title', () => {
    expect(newerVersions(versions, '0100A3A0149EC000', 0)).toEqual([]);
  });

  it('does not flag a dotted local version that already matches the latest', () => {
    const single = { '0100000000000000': { '65536': '2020-01-01' } };
    expect(newerVersions(single, '0100000000000000', rawVersionFromVersionText('1.0.0'))).toEqual([]);
  });
});

const titleId = '0100A3A0149EC000';
const mergedJson = mergeVersionRecords(VERSIONS_JSON_SAMPLE, {});
const updateStatus: Record<string, { text: string; available: Array<{ version: number; release_date: string }> }> =
  fixture.versions.updateStatus;

/** Current versions implied by the captured `file_version_number` outputs. */
const updateStatusCases: Array<[string, number]> = [
  [`${titleId}|none`, 0],
  [`${titleId}|Super Mario Odyssey [v131072].nsp`, 131072],
  [`${titleId}|Super Mario Odyssey [v262144].nsp`, 262144],
];

describe('update status inputs match the captured legacy behavior', () => {
  it.each(updateStatusCases)('%s', (key, current) => {
    const captured = updateStatus[key];
    const expectedAvailable: VersionInfoDto[] = captured.available.map((item) => ({
      version: item.version,
      releaseDate: item.release_date,
    }));
    const status = versionStatusInput({ localVersions: [current], titleId, versions: mergedJson });

    expect(captured.text.split('\n')[0]).toBe(`Latest Version on File: ${versionLabel(status.localVersion)}`);
    expect(status.localVersion).toBe(current);
    expect(status.latest).toEqual({ version: 131072, releaseDate: '2021-01-01' });
    expect(status.newer).toEqual(expectedAvailable);
  });
});

describe('versionStatusInput', () => {
  it('reports zero when no local versions are known', () => {
    const status = versionStatusInput({ localVersions: [], titleId, versions: mergedJson });

    expect(status.localVersion).toBe(0);
    expect(status.newer).toEqual([{ version: 131072, releaseDate: '2021-01-01' }]);
  });

  it('uses the highest local version across base and update files', () => {
    const status = versionStatusInput({
      localVersions: [65536, 196608, 131072],
      titleId,
      versions: mergedJson,
    });

    expect(status.localVersion).toBe(196608);
    expect(status.newer).toEqual([]);
  });

  it('reports an unknown latest for a title missing from the database', () => {
    expect(versionStatusInput({ localVersions: [65536], titleId: '0100000000000000', versions: {} })).toEqual({
      localVersion: 65536,
      latest: null,
      newer: [],
    });
  });
});
