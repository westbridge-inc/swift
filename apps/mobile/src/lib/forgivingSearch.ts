// ---------------------------------------------------------------------------
// FORGIVING IN-STORE SEARCH (owner, 13 Oct: search "can't find stuff when
// searching similar words or words that are part of the item").
//
// The in-store search box of a shop or supermarket filters the shelf the app
// already holds. It used to keep a product only when its name contained the
// typed text exactly as one piece: "brocoli", "tomatos", "rice white" or a
// plural found nothing. This applies the SAME rules the server's search uses
// (apps/api/src/modules/search/forgiving-text.ts), so a shopper gets the same
// forgiveness in a store as on the Search tab:
//
//   - every word on its own, in any order, anywhere in the name or description
//     (also inside a longer word);
//   - a typed plural finds its singular ("tomatoes" -> "tomato");
//   - from SLIP_MIN_LENGTH letters, ONE slip (a letter missing, extra, wrong
//     or two swapped) at the start of a word in the NAME.
//
// Results come strictest first — every word as typed, then every word with a
// slip, then any word as typed, then any word with a slip — so a product the
// shopper spelled correctly is always at the top.
// ---------------------------------------------------------------------------

const MIN_WORD_LENGTH = 2;
/** The fewest letters before one slip is forgiven — the server's floor. */
export const SLIP_MIN_LENGTH = 5;
const MAX_WORDS = 5;
const MIN_STEM_LENGTH = 3;

/** The words of a query: lower-cased, letters and digits only, de-duplicated. */
export function searchWords(q: string): string[] {
  const words = q.normalize('NFC').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= MIN_WORD_LENGTH);
  return [...new Set(words)].slice(0, MAX_WORDS);
}

/** A word and the singular forms of the plural typed. */
function literalForms(word: string): string[] {
  const forms = new Set([word]);
  const stem = (s: string) => { if (s.length >= MIN_STEM_LENGTH) forms.add(s); };
  if (word.length > MIN_STEM_LENGTH) {
    if (word.endsWith('ies')) { stem(`${word.slice(0, -3)}y`); stem(word.slice(0, -1)); }
    else if (word.endsWith('es')) { stem(word.slice(0, -2)); stem(word.slice(0, -1)); }
    else if (word.endsWith('s') && !word.endsWith('ss')) stem(word.slice(0, -1));
  }
  return [...forms];
}

/** Regex sources one slip from the word; `.` is the one letter that may differ or be missing. */
function slipForms(word: string): string[] {
  const chars = [...word];
  const n = chars.length;
  if (n < SLIP_MIN_LENGTH) return [];
  const out = new Set<string>();
  for (let i = 0; i < n; i += 1) {
    out.add([...chars.slice(0, i), '.', ...chars.slice(i + 1)].join('')); // wrong letter
    out.add([...chars.slice(0, i), ...chars.slice(i + 1)].join('')); // an extra letter typed
    if (i > 0) out.add([...chars.slice(0, i), '.', ...chars.slice(i)].join('')); // a letter left out
    if (i < n - 1 && chars[i] !== chars[i + 1]) out.add([...chars.slice(0, i), chars[i + 1]!, chars[i]!, ...chars.slice(i + 2)].join(''));
  }
  out.delete(word);
  return [...out];
}

type Matcher = (name: string, description: string) => boolean;

/** Does one word match, as typed (anywhere in name or description) or — with
 *  slips — one letter off at the start of a word in the name? Words hold only
 *  letters and digits, so they are safe regex sources as they stand. */
function wordMatcher(word: string, slips: boolean): Matcher {
  const literal = new RegExp(literalForms(word).join('|'), 'iu');
  const slip = slips && slipForms(word).length > 0
    ? new RegExp(slipForms(word).map((f) => `(?:^|\\s)${f}`).join('|'), 'iu')
    : null;
  return (name, description) => literal.test(name) || literal.test(description) || (slip !== null && slip.test(name));
}

/**
 * The products that match `q`, strictest tier first, each tier in the shelf's
 * own order. An empty or unsearchable query returns the shelf unchanged.
 */
export function forgivingFilter<T>(rows: readonly T[], q: string, text: (row: T) => { name?: unknown; description?: unknown }): T[] {
  const words = searchWords(q);
  if (words.length === 0) return q.trim() ? [] : [...rows];
  const canSlip = words.some((w) => w.length >= SLIP_MIN_LENGTH);
  const tiers: Array<{ every: boolean; slips: boolean }> = [
    { every: true, slips: false },
    ...(canSlip ? [{ every: true, slips: true }] : []),
    ...(words.length > 1 ? [{ every: false, slips: false }] : []),
    ...(words.length > 1 && canSlip ? [{ every: false, slips: true }] : []),
  ];
  const out: T[] = [];
  const taken = new Set<number>();
  for (const tier of tiers) {
    const matchers = words.map((w) => wordMatcher(w, tier.slips));
    rows.forEach((row, i) => {
      if (taken.has(i)) return;
      const t = text(row);
      const name = typeof t.name === 'string' ? t.name : '';
      const description = typeof t.description === 'string' ? t.description : '';
      const hit = tier.every ? matchers.every((m) => m(name, description)) : matchers.some((m) => m(name, description));
      if (hit) { taken.add(i); out.push(row); }
    });
  }
  return out;
}
