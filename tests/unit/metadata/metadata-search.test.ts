import { describe, expect, it } from 'vitest';
import fixture from '../../fixtures/legacy/behavior.json';
import {
  escapeIgdbQuery,
  metadataSearchQueries,
  normalizeMetadataTitle,
  titleSimilarity,
} from '../../../src/main/metadata/metadata-search';

const { normalizedTitles, searchQueries, titleSimilarity: similarityFixture, escapeQuery } = fixture.metadata;

describe('normalizeMetadataTitle', () => {
  it.each(Object.entries(normalizedTitles))('normalizes %j', (input, expected) => {
    expect(normalizeMetadataTitle(input)).toBe(expected);
  });

  it('folds the exotic punctuation the Qt build folds', () => {
    expect(normalizeMetadataTitle('Pokémon\uA789 Red & Blue')).toBe('Pokémon: Red & Blue');
    expect(normalizeMetadataTitle('“Quoted” – Dashed — Title\u2122\u00AE\u00A9')).toBe('"Quoted" - Dashed - Title');
  });

  it('collapses whitespace left behind by removed markers', () => {
    expect(normalizeMetadataTitle('  Metroid   Dread [0100]  ')).toBe('Metroid Dread');
  });
});

describe('metadataSearchQueries', () => {
  it.each(Object.entries(searchQueries))('builds queries for %j', (input, expected) => {
    expect(metadataSearchQueries(input)).toEqual(expected);
  });

  it('returns a single query when there is nothing to loosen', () => {
    expect(metadataSearchQueries('Hades')).toEqual(['Hades']);
  });

  it('strips separators left by generated candidates', () => {
    expect(metadataSearchQueries('Celeste:')).toEqual(['Celeste']);
  });
});

describe('titleSimilarity', () => {
  it.each(Object.entries(similarityFixture))('%j', (key, expected) => {
    const [left, right] = key.split('||');
    expect(titleSimilarity(left, right)).toBeCloseTo(expected, 10);
  });

  it('treats an empty side as no match', () => {
    expect(titleSimilarity('', 'Hades')).toBe(0);
    expect(titleSimilarity('   ', 'Hades')).toBe(0);
  });
});

describe('escapeIgdbQuery', () => {
  it.each(Object.entries(escapeQuery))('escapes %j', (input, expected) => {
    expect(escapeIgdbQuery(input)).toBe(expected);
  });
});
