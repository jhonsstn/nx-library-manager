import { TITLE_ID_MATCH_CONFIDENCE } from '../../shared/constants';
import { indelRatio } from '../../shared/text/similarity';
import { cleanTitle, titleIdFamily } from './filename-parser';

/**
 * Port of the pure matching helpers in `switch_catalog/scanner.py`
 * (`_match_update`, `_match_update_by_title_id`, `_title_match_score`).
 */

/** The subset of a stored game the matcher reads (`scanner.py` rows). */
export interface MatchCandidateGame {
  id: number;
  displayTitle: string;
  cleanedTitle: string;
  fileName: string | null;
}

export interface UpdateMatch {
  gameId: number | null;
  confidence: number;
}

/**
 * `_title_match_score`: prefix relations get fixed scores, everything else falls
 * back to rapidfuzz's indel ratio normalized to `[0, 1]`.
 */
export function titleMatchScore(updateTitle: string, gameTitle: string): number {
  const update = updateTitle.trim().split(/\s+/).join(' ');
  const game = gameTitle.trim().split(/\s+/).join(' ');
  if (!update || !game) return 0;
  if (update === game) return 1;
  if (update.startsWith(`${game} `)) return 0.96;
  if (update.startsWith(game)) return 0.93;
  if (` ${update} `.includes(` ${game} `)) return 0.9;
  if (update.startsWith(`${game} ${game} `)) return 0.97;
  return indelRatio(update, game);
}

/**
 * `_match_update_by_title_id`: the update and the game's base file must share the
 * 12 character title-ID family, and exactly one game must match it.
 */
export function matchUpdateByTitleId(fileName: string, games: MatchCandidateGame[]): UpdateMatch {
  const updateFamily = titleIdFamily(fileName);
  if (!updateFamily) return { gameId: null, confidence: 0 };

  const matches: number[] = [];
  for (const game of games) {
    const baseFamily = titleIdFamily(game.fileName ?? '');
    if (baseFamily && baseFamily === updateFamily) matches.push(game.id);
  }
  if (new Set(matches).size === 1) {
    return { gameId: matches[0], confidence: TITLE_ID_MATCH_CONFIDENCE };
  }
  return { gameId: null, confidence: 0 };
}

/**
 * `_match_update`: title-ID relation first, then the best fuzzy score over each
 * game's cleaned and display titles. Ties keep the earliest game because
 * strict `score > best_score`.
 */
export function matchUpdate(fileName: string, games: MatchCandidateGame[]): UpdateMatch {
  const idMatch = matchUpdateByTitleId(fileName, games);
  if (idMatch.gameId !== null) return idMatch;

  const updateTitle = cleanTitle(fileName, { forUpdate: true }).toLowerCase();
  if (!updateTitle) return { gameId: null, confidence: 0 };

  let bestId: number | null = null;
  let bestScore = 0;
  for (const game of games) {
    const candidates = new Set([game.cleanedTitle.toLowerCase(), game.displayTitle.toLowerCase()]);
    let score = 0;
    for (const candidate of candidates) score = Math.max(score, titleMatchScore(updateTitle, candidate));
    if (score > bestScore) {
      bestScore = score;
      bestId = game.id;
    }
  }
  return { gameId: bestId, confidence: bestScore };
}

/** The scanner's `if confidence < threshold: matched_game_id = None`; the score is kept. */
export function applyMatchThreshold(match: UpdateMatch, threshold: number): UpdateMatch {
  if (match.confidence < threshold) return { gameId: null, confidence: match.confidence };
  return match;
}
