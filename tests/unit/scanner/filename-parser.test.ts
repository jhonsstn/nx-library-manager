import { describe, expect, it } from 'vitest';
import { classifyGameFile, updateFileGroup } from '@main/scanner/classify-file';
import {
  cleanTitle,
  detectVersion,
  extractTitleId,
  parseSwitchFilename,
  titleIdFamily,
} from '@main/scanner/filename-parser';

describe('classifyGameFile', () => {
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
