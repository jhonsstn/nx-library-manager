import { describe, expect, it } from 'vitest';
import fixture from '../../fixtures/legacy/behavior.json';
import { detectedVersionSuffix, rawVersionFromVersionText } from '@shared/format/versions';
import { classifyGameFile, updateFileGroup } from '@main/scanner/classify-file';
import {
  cleanTitle,
  detectVersion,
  extractTitleId,
  isSupportedExtension,
  isUpdateOrDlcFilename,
  parseSwitchFilename,
  titleIdFamily,
} from '@main/scanner/filename-parser';

const cases = fixture.filename;

const SUPPORTED_NAME_RE = /\.(nsp|nsz|xci)$/i;

describe('legacy filename fixtures', () => {
  it.each(cases)('$fileName', (entry) => {
    expect(detectVersion(entry.fileName)).toBe(entry.detectVersion);
    expect(extractTitleId(entry.fileName)).toBe(entry.titleId);
    expect(titleIdFamily(entry.fileName)).toBe(entry.titleIdFamily);
    expect(isUpdateOrDlcFilename(entry.fileName)).toBe(entry.isUpdateOrDlc);
    expect(cleanTitle(entry.fileName)).toBe(entry.cleanedTitle);
    expect(cleanTitle(entry.fileName, { forUpdate: true })).toBe(entry.cleanedTitleForUpdate);
    expect(updateFileGroup(entry.fileName)).toBe(entry.updateGroup);

    const parsed = parseSwitchFilename(entry.fileName);
    expect(parsed.originalName).toBe(entry.fileName);
    expect(parsed.extension).toBe(entry.fileName.split('.').pop()?.toLowerCase());
    expect(parsed.normalizedTitle).toBe(entry.cleanedTitle);
    expect(parsed.titleId ?? '').toBe(entry.titleId);
    expect(parsed.rawVersion ?? '').toBe(entry.detectVersion);
    // `rawVersion` is the captured `_detected_raw_version(detected) if detected else 0`.
    expect(rawVersionFromVersionText(parsed.rawVersion ?? '')).toBe(entry.rawVersion);
    expect(parsed.versionNumber ?? 0).toBe(entry.rawVersion);
    expect(detectedVersionSuffix(parsed.rawVersion ?? '')).toBe(entry.versionSuffix);

    const supported = SUPPORTED_NAME_RE.test(entry.fileName);
    expect(isSupportedExtension(entry.fileName)).toBe(supported);
    const expectedKind = !supported
      ? 'unknown'
      : entry.isUpdateOrDlc
        ? entry.updateGroup === 'DLC'
          ? 'dlc'
          : 'update'
        : 'base';
    expect(parsed.probableKind).toBe(expectedKind);
  });
});

describe('classifyGameFile', () => {
  it('mirrors the captured update group for every fixture', () => {
    for (const entry of cases) {
      const classification = classifyGameFile(entry.fileName);
      expect(classification.group).toBe(entry.updateGroup);
      if (SUPPORTED_NAME_RE.test(entry.fileName)) {
        expect(classification.kind).toBe(
          entry.isUpdateOrDlc ? (entry.updateGroup === 'DLC' ? 'dlc' : 'update') : 'base',
        );
      }
    }
  });

  it('groups DLC names and DLC content types', () => {
    expect(updateFileGroup('Game [DLC] v1.nsp')).toBe('DLC');
    expect(updateFileGroup('0100ABCDEF123456.nsp')).toBe('DLC');
    expect(classifyGameFile('Splatoon 3 [DLC] Wave 1.nsp')).toEqual({ kind: 'dlc', group: 'DLC' });
  });

  it('keeps base and update title IDs in Updates', () => {
    expect(updateFileGroup('Hades.nsz')).toBe('Updates');
    expect(updateFileGroup('Super Mario Odyssey [0100000000010000].nsp')).toBe('Updates');
    expect(updateFileGroup('Super Mario Odyssey [0100000000010800].nsp')).toBe('Updates');
    expect(classifyGameFile('Hades.nsz')).toEqual({ kind: 'base', group: 'Updates' });
    expect(classifyGameFile('Hades Update v1.0.0.nsp')).toEqual({ kind: 'update', group: 'Updates' });
  });
});

describe('detectVersion precedence', () => {
  it('prefers a bracketed version over everything else', () => {
    expect(detectVersion('Game Update v131072 [v65536].nsp')).toBe('65536');
  });

  it('prefers an update marker over a generic version run', () => {
    expect(detectVersion('Game v2.0 Update v1.2.nsp')).toBe('1.2');
  });

  it('reads an all-digit title ID as the version', () => {
    expect(detectVersion('0100000000010000.nsp')).toBe('0100000000010000');
  });

  it('ignores an identifier with hex letters', () => {
    expect(detectVersion('0100ABCDEF123456.nsp')).toBe('');
  });
});

describe('extractTitleId', () => {
  it('uppercases a valid identifier', () => {
    expect(extractTitleId('hades [0100a3a0149ec800].nsp')).toBe('0100A3A0149EC800');
    expect(titleIdFamily('hades [0100a3a0149ec800].nsp')).toBe('0100A3A0149E');
  });

  it('rejects truncated, overlong and non-hex identifiers', () => {
    expect(extractTitleId('0100ABCDEF12345.nsp')).toBe('');
    expect(extractTitleId('0100ABCDEF1234567.nsp')).toBe('');
    expect(extractTitleId('0100ABCDEF12345G.nsp')).toBe('');
    expect(titleIdFamily('Hades.nsp')).toBe('');
  });
});

describe('cleanTitle mirrors Python case handling', () => {
  it('title-cases an all-lowercase title', () => {
    expect(cleanTitle('some game.nsp')).toBe('Some Game');
  });

  it('leaves an already mixed-case title alone', () => {
    expect(cleanTitle('tHE gAME.nsp')).toBe('tHE gAME');
  });

  it('title-cases after an apostrophe like str.title', () => {
    expect(cleanTitle("don't starve.nsp")).toBe("Don'T Starve");
    expect(cleanTitle('hades ii.nsp')).toBe('Hades Ii');
  });

  it('title-cases accented titles without damaging them', () => {
    expect(cleanTitle('straße deluxe.nsp')).toBe('Straße Deluxe');
    expect(cleanTitle('pokémon scarlet.nsp')).toBe('Pokémon Scarlet');
    expect(cleanTitle('café tropico.nsz')).toBe('Café Tropico');
  });
});

describe('parseSwitchFilename', () => {
  it('parses a clean base game', () => {
    expect(parseSwitchFilename('The Legend of Zelda - Breath of the Wild.nsp')).toEqual({
      originalName: 'The Legend of Zelda - Breath of the Wild.nsp',
      extension: 'nsp',
      normalizedTitle: 'The Legend of Zelda Breath of the Wild',
      markers: [],
      probableKind: 'base',
    });
  });

  it('parses a DLC file', () => {
    expect(parseSwitchFilename('Splatoon 3 [DLC] Wave 1.nsz')).toEqual({
      originalName: 'Splatoon 3 [DLC] Wave 1.nsz',
      extension: 'nsz',
      normalizedTitle: 'Splatoon 3 Wave 1',
      markers: ['dlc'],
      probableKind: 'dlc',
    });
  });

  it('parses an update with a title ID and a bracketed version', () => {
    expect(parseSwitchFilename('Hades [0100A3A0149EC800][v131072][UPD].nsp')).toEqual({
      originalName: 'Hades [0100A3A0149EC800][v131072][UPD].nsp',
      extension: 'nsp',
      normalizedTitle: 'Hades',
      titleId: '0100A3A0149EC800',
      rawVersion: '131072',
      versionNumber: 131072,
      markers: ['v131072', 'upd'],
      probableKind: 'update',
    });
  });

  it('markers follow document order and skip title IDs', () => {
    expect(parseSwitchFilename('Metroid Dread (World) (En,Fr,De) [010093801237C000].nsz').markers).toEqual([
      'world',
      'en,fr,de',
    ]);
    expect(parseSwitchFilename('Xenoblade Chronicles 3 v2.1.0 [update].nsp').markers).toEqual(['update']);
  });

  it('reports an unsupported extension as unknown', () => {
    expect(parseSwitchFilename('NotAGame.txt')).toEqual({
      originalName: 'NotAGame.txt',
      extension: 'txt',
      normalizedTitle: 'NotAGame',
      markers: [],
      probableKind: 'unknown',
    });
  });
});
