/**
 * Small scored matcher for the command palette. Three match tiers, best
 * field wins:
 *
 *   word-prefix (query starts the text or any word in it)
 *     > substring (query appears anywhere)
 *       > subsequence (query chars appear in order, e.g. "svfl" -> "Save file")
 *
 * Fields carry weights so a title hit outranks the same hit on a subtitle or
 * id. A small length penalty breaks ties toward shorter texts; it is capped
 * well below the smallest weighted tier gap so it can never flip tiers.
 */

export interface FuzzyField {
  text: string | undefined;
  /** Relative importance, e.g. title 1 > subtitle 0.7 > id/group 0.4. */
  weight: number;
}

const TIER_WORD_PREFIX = 100;
const TIER_SUBSTRING = 60;
const TIER_SUBSEQUENCE = 30;

const isWordChar = (ch: string): boolean => /[a-z0-9]/i.test(ch);

const isSubsequence = (q: string, t: string): boolean => {
  let i = 0;
  for (let j = 0; j < t.length && i < q.length; j++) {
    if (t[j] === q[i]) i++;
  }
  return i === q.length;
};

/**
 * Match tier for `query` against `text`, case-insensitive. `null` = no match;
 * an empty query matches everything at tier 0.
 */
export function matchTier(query: string, text: string): number | null {
  if (!query) return 0;
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  const idx = t.indexOf(q);
  if (idx === 0) return TIER_WORD_PREFIX;
  if (idx > 0) {
    return isWordChar(t[idx - 1]) ? TIER_SUBSTRING : TIER_WORD_PREFIX;
  }
  return isSubsequence(q, t) ? TIER_SUBSEQUENCE : null;
}

/**
 * Best weighted score across fields, or `null` when no field matches.
 * Higher is better; an empty query scores 0 on everything (match-all).
 */
export function scoreFields(
  query: string,
  fields: readonly FuzzyField[],
): number | null {
  if (!query) return 0;
  let best: number | null = null;
  for (const f of fields) {
    if (!f.text) continue;
    const tier = matchTier(query, f.text);
    if (tier === null) continue;
    // Length penalty caps at 5; the smallest weighted tier gap is 12
    // (30-point gap x 0.4 weight), so ties break on length within a tier
    // without ever reordering across tiers.
    const score = tier * f.weight - Math.min(f.text.length, 100) * 0.05;
    if (best === null || score > best) best = score;
  }
  return best;
}
