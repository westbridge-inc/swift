// ---------------------------------------------------------------------------
// Stage A — the alias matcher (category spec Part 4). Deterministic,
// synchronous, free. Pure functions: item text + taxonomy in, scored
// suggestions out; the fixture harness (CAT-D) gates accuracy in CI —
// precision ≥ 85%, recall ≥ 70% on 120 labeled Guyanese catalog lines.
// If the matcher misses, extend aliases — never lower the gate.
// ---------------------------------------------------------------------------

/** Platform knob CAT_MATCH_MIN — minimum score to file a suggestion. */
export const CAT_MATCH_MIN = 0.6;
/** Platform knob CAT_MAX_ITEM_TAGS — the ceiling everywhere. */
export const CAT_MAX_ITEM_TAGS = 3;

export interface MatchableCategory {
  slug: string;
  name: string;
  aliases: string[];
}

export interface MatchableItem {
  name: string;
  description?: string | null;
}

/** lowercase → strip accents/punctuation → collapse whitespace. */
export function normalize(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const wordSet = (normalized: string): Set<string> => new Set(normalized.split(' ').filter(Boolean));

/** Whole-phrase presence with word boundaries (substring alone would let
 *  "rice" hit "price"). */
function hasPhrase(haystack: string, phrase: string): boolean {
  return ` ${haystack} `.includes(` ${phrase} `);
}

/**
 * Score one item against one category. Each alias (plus the category name)
 * contributes its BEST placement once:
 *   phrase in name 1.0 · word in name 0.7 · phrase in description 0.5 ·
 *   word in description 0.3 — score = min(1, Σ).
 */
export function scoreCategory(item: MatchableItem, category: MatchableCategory): number {
  const name = normalize(item.name);
  const desc = normalize(item.description ?? '');
  const nameWords = wordSet(name);
  const descWords = wordSet(desc);

  let total = 0;
  const terms = new Set([normalize(category.name), ...category.aliases.map(normalize)].filter(Boolean));
  for (const term of terms) {
    const isPhrase = term.includes(' ');
    let weight = 0;
    if (isPhrase) {
      if (hasPhrase(name, term)) weight = 1.0;
      else if (hasPhrase(desc, term)) weight = 0.5;
    } else {
      if (nameWords.has(term)) weight = 0.7;
      else if (descWords.has(term)) weight = 0.3;
    }
    total += weight;
  }
  return Math.min(1, total);
}

export interface MatcherSuggestion {
  slug: string;
  confidence: number;
}

/** Top 3 categories scoring ≥ CAT_MATCH_MIN, best first. */
export function suggestCategories(
  item: MatchableItem,
  taxonomy: MatchableCategory[],
  minScore = CAT_MATCH_MIN,
): MatcherSuggestion[] {
  return taxonomy
    .map((category) => ({ slug: category.slug, confidence: Number(scoreCategory(item, category).toFixed(2)) }))
    .filter((s) => s.confidence >= minScore)
    .sort((a, b) => b.confidence - a.confidence || a.slug.localeCompare(b.slug))
    .slice(0, CAT_MAX_ITEM_TAGS);
}
