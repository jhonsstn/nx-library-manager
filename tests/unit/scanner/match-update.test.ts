import { describe, expect, it } from 'vitest';
import { DEFAULT_FUZZY_MATCH_THRESHOLD } from '@shared/constants';
import { cleanTitle } from '@main/scanner/filename-parser';
import {
  applyMatchThreshold,
  matchUpdate,
  matchUpdateByTitleId,
  titleMatchScore,
  type MatchCandidateGame,
} from '@main/scanner/match-update';

function buildGames(gameFileNames: string[]): MatchCandidateGame[] {
  return gameFileNames.map((fileName, index) => {
    const title = cleanTitle(fileName);
    return { id: index + 1, displayTitle: title, cleanedTitle: title, fileName };
  });
}

describe('titleMatchScore', () => {
  it('applies the legacy prefix scores', () => {
    expect(titleMatchScore('super mario odyssey', 'super mario odyssey')).toBe(1);
    expect(titleMatchScore('super mario odyssey deluxe', 'super mario odyssey')).toBe(0.96);
    expect(titleMatchScore('hadesii', 'hades')).toBe(0.93);
    expect(titleMatchScore('super mario odyssey update', 'mario odyssey')).toBe(0.9);
  });

  it('collapses whitespace before comparing', () => {
    expect(titleMatchScore('  super   mario  odyssey ', 'super mario odyssey')).toBe(1);
  });

  it('falls back to the indel ratio and rejects empty titles', () => {
    expect(titleMatchScore('zelda', 'hades')).toBeCloseTo(0.2, 10);
    expect(titleMatchScore('', 'hades')).toBe(0);
    expect(titleMatchScore('hades', '')).toBe(0);
  });
});

describe('applyMatchThreshold', () => {
  it('discards an id below the threshold but keeps the real score', () => {
    expect(applyMatchThreshold({ gameId: 7, confidence: 0.5 }, DEFAULT_FUZZY_MATCH_THRESHOLD)).toEqual({
      gameId: null,
      confidence: 0.5,
    });
  });

  it('keeps an id at or above the threshold', () => {
    expect(applyMatchThreshold({ gameId: 7, confidence: 0.9 }, DEFAULT_FUZZY_MATCH_THRESHOLD)).toEqual({
      gameId: 7,
      confidence: 0.9,
    });
    expect(
      applyMatchThreshold({ gameId: 7, confidence: DEFAULT_FUZZY_MATCH_THRESHOLD }, DEFAULT_FUZZY_MATCH_THRESHOLD)
        .gameId,
    ).toBe(7);
  });
});

describe('ambiguity', () => {
  it('drops a title-ID relation shared by two games', () => {
    const games = buildGames(['Hades [0100A3A0149EC000].nsp', 'Hades Update [0100A3A0149EC800].nsp']);
    const idMatch = matchUpdateByTitleId('Hades [0100A3A0149EC800][v131072][UPD].nsp', games);
    expect(idMatch).toEqual({ gameId: null, confidence: 0 });
    expect(applyMatchThreshold(idMatch, DEFAULT_FUZZY_MATCH_THRESHOLD).gameId).toBeNull();
  });

  it('keeps the earliest candidate on an exact fuzzy tie, like the legacy scanner', () => {
    // Python's `score > best_score` keeps the first of two identical titles; the Qt
    // build never treated fuzzy ties as ambiguous, so the port keeps that behaviour.
    const games = buildGames(['Hades.nsp', 'Hades.nsz']);
    expect(matchUpdate('Hades Update v1.0.0.nsp', games)).toEqual({ gameId: 1, confidence: 1 });
  });

  it('prefers the title-ID relation over a fuzzy title match', () => {
    const games = buildGames(['Hades [0100A3A0149EC000].nsp', 'Super Mario Odyssey.nsp']);
    expect(matchUpdate('Hades Update [0100A3A0149EC800][v131072].nsp', games)).toEqual({
      gameId: 1,
      confidence: 0.99,
    });
  });

  it('returns no match when the update carries no usable title', () => {
    const games = buildGames(['Hades.nsp']);
    expect(matchUpdate('0100ABCDEF123456.nsp', games)).toEqual({ gameId: null, confidence: 0 });
    expect(matchUpdate('Hades Update v1.0.0.nsp', [])).toEqual({ gameId: null, confidence: 0 });
  });
});
