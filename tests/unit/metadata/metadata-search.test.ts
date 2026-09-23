import { describe, expect, it } from 'vitest';
import {
  escapeIgdbQuery,
  metadataSearchQueries,
  normalizeMetadataTitle,
  titleSimilarity,
} from '../../../src/main/metadata/metadata-search';

describe('normalizeMetadataTitle', () => {
  it('folds the exotic punctuation the Qt build folds', () => {
    expect(normalizeMetadataTitle('Pokémon\uA789 Red & Blue')).toBe('Pokémon: Red & Blue');
    expect(normalizeMetadataTitle('“Quoted” – Dashed — Title\u2122\u00AE\u00A9')).toBe('"Quoted" - Dashed - Title');
  });

  it('collapses whitespace left behind by removed markers', () => {
    expect(normalizeMetadataTitle('  Metroid   Dread [0100]  ')).toBe('Metroid Dread');
  });
});

describe('metadataSearchQueries', () => {
  it('returns a single query when there is nothing to loosen', () => {
    expect(metadataSearchQueries('Hades')).toEqual(['Hades']);
  });

  it('strips separators left by generated candidates', () => {
    expect(metadataSearchQueries('Celeste:')).toEqual(['Celeste']);
  });
});

describe('titleSimilarity', () => {
  it('treats an empty side as no match', () => {
    expect(titleSimilarity('', 'Hades')).toBe(0);
    expect(titleSimilarity('   ', 'Hades')).toBe(0);
  });
});

describe('escapeIgdbQuery', () => {
  it('escapes quotes and backslashes', () => {
    expect(escapeIgdbQuery('A "quote" \\ path')).toBe('A \\"quote\\" \\\\ path');
  });
});
