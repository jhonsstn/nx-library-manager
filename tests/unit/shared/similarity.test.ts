import { describe, expect, it } from 'vitest';
import fixture from '../../fixtures/legacy/behavior.json';
import { indelRatio, sequenceMatcherRatio } from '@shared/text/similarity';

const fuzzRatio = fixture.metadata.fuzzRatio;
const sequenceRatio = fixture.metadata.sequenceMatcherRatio;

if (!fuzzRatio) {
  throw new Error('The legacy behaviour fixture is missing its fuzzy-ratio samples.');
}

function pairs(source: Record<string, number>): Array<[string, string, number]> {
  return Object.entries(source).map(([key, expected]) => {
    const [left, right] = key.split('||');
    return [left, right, expected];
  });
}

describe('indelRatio mirrors rapidfuzz.fuzz.ratio', () => {
  it.each(pairs(fuzzRatio))('%j vs %j', (left, right, expected) => {
    expect(indelRatio(left, right)).toBeCloseTo(expected, 10);
  });
});

describe('sequenceMatcherRatio mirrors difflib.SequenceMatcher.ratio', () => {
  it.each(pairs(sequenceRatio))('%j vs %j', (left, right, expected) => {
    expect(sequenceMatcherRatio(left, right)).toBeCloseTo(expected, 10);
  });
});
