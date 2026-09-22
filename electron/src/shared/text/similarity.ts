/**
 * Text similarity primitives kept pure so the ports of the Python matching
 * algorithms can be cross-checked against the originals in unit tests.
 */

/**
 * Normalized Indel similarity in the range `[0, 1]`.
 *
 * Mirrors `rapidfuzz.fuzz.ratio`, which the Qt application uses for fuzzy update
 * title matching. rapidfuzz's `ratio` is LCS-based (`2 * lcs / (len(a) + len(b))`),
 * which is not the same as normalized Levenshtein distance.
 */
export function indelRatio(a: string, b: string): number {
  if (a === b) return 1;
  const left = [...a];
  const right = [...b];
  const total = left.length + right.length;
  if (total === 0) return 1;
  if (left.length === 0 || right.length === 0) return 0;

  let previous = new Array<number>(right.length + 1).fill(0);
  let current = new Array<number>(right.length + 1).fill(0);
  for (const char of left) {
    for (let j = 1; j <= right.length; j += 1) {
      current[j] = char === right[j - 1] ? previous[j - 1] + 1 : Math.max(previous[j], current[j - 1]);
    }
    const swap = previous;
    previous = current;
    current = swap;
    current.fill(0);
  }
  return (2 * previous[right.length]) / total;
}

/**
 * `difflib.SequenceMatcher(None, a, b).ratio()` — Gestalt (Ratcliff/Obershelp)
 * similarity in the range `[0, 1]`.
 *
 * Used by metadata confidence scoring. `autojunk` is not modelled: it only
 * applies to sequences of 200+ elements, which game titles never reach.
 */
export function sequenceMatcherRatio(a: string, b: string): number {
  if (a.length === 0 && b.length === 0) return 1;
  if (a.length === 0 || b.length === 0) return 0;
  const left = [...a];
  const right = [...b];
  const positions = new Map<string, number[]>();
  right.forEach((char, index) => {
    const list = positions.get(char);
    if (list) list.push(index);
    else positions.set(char, [index]);
  });

  const findLongestMatch = (
    alo: number,
    ahi: number,
    blo: number,
    bhi: number,
  ): { i: number; j: number; size: number } => {
    let bestI = alo;
    let bestJ = blo;
    let bestSize = 0;
    let previous = new Map<number, number>();
    for (let i = alo; i < ahi; i += 1) {
      const current = new Map<number, number>();
      for (const j of positions.get(left[i]) ?? []) {
        if (j < blo) continue;
        if (j >= bhi) break;
        const size = (previous.get(j - 1) ?? 0) + 1;
        current.set(j, size);
        if (size > bestSize) {
          bestI = i - size + 1;
          bestJ = j - size + 1;
          bestSize = size;
        }
      }
      previous = current;
    }
    return { i: bestI, j: bestJ, size: bestSize };
  };

  let matched = 0;
  const queue: Array<[number, number, number, number]> = [[0, left.length, 0, right.length]];
  while (queue.length > 0) {
    const [alo, ahi, blo, bhi] = queue.pop() as [number, number, number, number];
    const match = findLongestMatch(alo, ahi, blo, bhi);
    if (match.size === 0) continue;
    matched += match.size;
    if (alo < match.i && blo < match.j) queue.push([alo, match.i, blo, match.j]);
    if (match.i + match.size < ahi && match.j + match.size < bhi) {
      queue.push([match.i + match.size, ahi, match.j + match.size, bhi]);
    }
  }
  return (2 * matched) / (left.length + right.length);
}
