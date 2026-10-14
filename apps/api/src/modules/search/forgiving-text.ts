// ---------------------------------------------------------------------------
// FORGIVING TEXT MATCH — the database half of customer search (owner, 13 Oct:
// "can't find stuff when searching similar words or words that are part of
// the item").
//
// Every database search door used to match ONE substring of the whole typed
// text (`name ILIKE '%<q>%'`): a misspelling ("chiken"), a plural ("burgers"
// for "Beef Burger"), a missing or extra letter ("brocoli", "broccolli") or
// the words in another order ("curry chicken") found nothing. These helpers
// split the text into words and give each word the forms it may take in the
// catalogue, so the plain Postgres the platform already runs (no extension,
// no migration) can match the way the index does:
//
//   - every word on its own, in any order, anywhere in the text (also inside
//     a longer word: "doori" finds "Tandoori");
//   - a plural finds its singular ("burgers" -> "burger", "patties" -> "patty");
//   - from MIN_TYPO_LENGTH letters, ONE slip in a NAME: a letter missing,
//     extra, wrong or two letters swapped — never the first letter, and at the
//     start of a word — the same floor and the same word-start rule
//     Meilisearch uses for one typo, so the two engines forgive the same
//     slips. Slip forms are bounded per word and per query (MAX_SLIP_*).
//
// Exact matches always rank first: callers ask for the strict tiers before
// the forgiving ones (`searchTiers`), so a typo match never displaces a word
// that was typed correctly.
//
// SAFETY: a word keeps only letters and digits, so nothing a customer types
// can reach the LIKE pattern as a wildcard (`%`, `_`, `\`). The ONE wildcard
// in a pattern is the `_` placed here for a slip. A query of only one-letter
// words is matched as its whole text with `%`, `_` and `\` removed. These helpers only build the
// TEXT half of a query; every caller still ANDs its own visibility predicate.
// ---------------------------------------------------------------------------

/** Words shorter than this are dropped ("a", "&") from a query that has a
 *  longer word; a query of ONLY such words matches its whole text as one
 *  exact piece instead (wholeQueryLiteral). */
const MIN_TERM_LENGTH = 2;
/** The fewest letters a word needs before one slip is forgiven. Meilisearch's default floor for one typo. */
export const MIN_TYPO_LENGTH = 5;
/** Words past this many are ignored, which bounds the size of the query a long paste can build. */
export const MAX_TERMS = 5;
/** A stem is never shorter than this ("bus" must not become "bu"). */
const MIN_STEM_LENGTH = 3;
/** A word longer than this is matched as typed only. Its slip forms grow
 *  with its length (about four per letter, each two LIKE clauses), and no
 *  catalogue word is this long — a pasted run of letters must not turn into a
 *  thousand-clause query on a public door (DS1080 S2). */
export const MAX_SLIP_WORD_LENGTH = 20;
/** The most slip forms one query carries across all its words. Words past the
 *  budget are matched as typed only, so a query's size is bounded however it
 *  is made up (five seven-letter words fit). */
export const MAX_SLIP_FORMS = 120;

/** The words of a query: lower-cased, letters and digits only, de-duplicated, at most MAX_TERMS. */
export function searchTerms(q: string): string[] {
  const words = q.normalize('NFC').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= MIN_TERM_LENGTH);
  return [...new Set(words)].slice(0, MAX_TERMS);
}

/** A word and its singular forms. Matching is by substring, so a singular
 *  also finds the plural ("burger" is inside "burgers"): only the plural the
 *  customer typed needs undoing. */
export function literalForms(term: string): string[] {
  const forms = new Set([term]);
  const stem = (s: string) => { if (s.length >= MIN_STEM_LENGTH) forms.add(s); };
  if (term.length > MIN_STEM_LENGTH) {
    if (term.endsWith('ies')) { stem(`${term.slice(0, -3)}y`); stem(term.slice(0, -1)); }
    else if (term.endsWith('es')) { stem(term.slice(0, -2)); stem(term.slice(0, -1)); }
    else if (term.endsWith('s') && !term.endsWith('ss')) stem(term.slice(0, -1));
  }
  return [...forms];
}

/** Every LIKE pattern one slip away from the word, `_` standing for exactly
 *  one letter: a letter wrong, a letter missing from what was typed, an extra
 *  letter typed, two neighbours swapped. The FIRST letter is never part of a
 *  slip — as in Meilisearch, a word is found by how it starts — which also
 *  keeps "bread" from turning into "read". Empty below MIN_TYPO_LENGTH and
 *  above MAX_SLIP_WORD_LENGTH. */
export function typoForms(term: string): string[] {
  const chars = [...term];
  const n = chars.length;
  if (n < MIN_TYPO_LENGTH || n > MAX_SLIP_WORD_LENGTH) return [];
  const out = new Set<string>();
  const join = (parts: string[]) => parts.join('');
  for (let i = 1; i < n; i += 1) {
    out.add(join([...chars.slice(0, i), '_', ...chars.slice(i + 1)])); // wrong letter
    out.add(join([...chars.slice(0, i), ...chars.slice(i + 1)])); // an extra letter was typed
    out.add(join([...chars.slice(0, i), '_', ...chars.slice(i)])); // a letter was left out
    if (i < n - 1 && chars[i] !== chars[i + 1]) {
      out.add(join([...chars.slice(0, i), chars[i + 1]!, chars[i]!, ...chars.slice(i + 2)])); // two letters swapped
    }
  }
  out.delete(term);
  return [...out];
}

/** Which words of a query get slip forms, within MAX_SLIP_FORMS, in the order typed. */
function slipPlan(terms: string[]): Map<string, string[]> {
  const plan = new Map<string, string[]>();
  let budget = MAX_SLIP_FORMS;
  for (const t of terms) {
    const forms = typoForms(t);
    if (forms.length > 0 && forms.length <= budget) {
      plan.set(t, forms);
      budget -= forms.length;
    }
  }
  return plan;
}

type Where = Record<string, unknown>;

/** Which catalogue columns a search reads. `text`: free text, matched as a
 *  case-insensitive substring of any literal form. `typoText` (default: none):
 *  the columns where a SLIP is also forgiven — names, never long descriptions,
 *  where one-letter-off substrings would match almost anything. A slip match
 *  is anchored at the START of a word (the text start, or after a space), the
 *  way the index matches word prefixes: "bread" with a slip may find "Ready
 *  meal", never "thread". `lists`: String[] tag columns, an element equal to a
 *  literal form in the casings a tag is written in (the old `hasSome: [q]`). */
export type SearchColumns = { text: readonly string[]; typoText?: readonly string[]; lists?: readonly string[] };

function casings(forms: string[]): string[] {
  const out = new Set<string>();
  for (const f of forms) {
    out.add(f);
    out.add(f.charAt(0).toUpperCase() + f.slice(1));
    out.add(f.toUpperCase());
  }
  return [...out];
}

/** One word, in any of its forms, in any of the columns. `slips`: the word's
 *  slip forms when this tier forgives one (from `slipPlan`), else empty. */
function termWhere(columns: SearchColumns, term: string, slips: readonly string[]): Where {
  const literal = literalForms(term);
  const or: Where[] = [];
  for (const column of columns.text) {
    for (const form of literal) or.push({ [column]: { contains: form, mode: 'insensitive' } });
  }
  const typoColumns = columns.typoText ?? [];
  if (slips.length > 0 && typoColumns.length > 0) {
    const slipOr: Where[] = [];
    for (const column of typoColumns) {
      for (const form of slips) {
        slipOr.push({ [column]: { startsWith: form, mode: 'insensitive' } });
        slipOr.push({ [column]: { contains: ` ${form}`, mode: 'insensitive' } });
      }
    }
    // [Review S2-1] A cheap gate in FRONT of the slip clauses, so the ~250
    // slip clauses run only for rows that could match. Exactness-preserving
    // (slipGate below; proved by enumeration in the unit test).
    or.push({ AND: [slipGateWhere(typoColumns, term), { OR: slipOr }] });
  }
  for (const column of columns.lists ?? []) or.push({ [column]: { hasSome: casings(literal) } });
  return { OR: or };
}

/**
 * A necessary condition for ANY slip form of `term` to match a text: one slip
 * (never in the first letter, always at a word start) leaves at least one of
 *   - the first two letters at a word start (a slip at the third letter or later),
 *   - the first and third letters at a word start (a wrong, missing or swapped
 *     second letter, or an extra one typed there),
 *   - the letters from the third on, intact somewhere (a letter left out or an
 *     extra one typed right after the first).
 * Far more selective than "a word starting with the first letter", and never
 * stricter than the slip clauses themselves.
 */
export function slipGate(term: string): { wordStarts: string[]; inside: string } {
  const c = [...term];
  return { wordStarts: [...new Set([c[0]! + c[1]!, c[0]! + c[2]!])], inside: c.slice(2).join('') };
}

function slipGateWhere(columns: readonly string[], term: string): Where {
  const gate = slipGate(term);
  return {
    OR: columns.flatMap((column) => [
      ...gate.wordStarts.flatMap((p) => [
        { [column]: { startsWith: p, mode: 'insensitive' } },
        { [column]: { contains: ` ${p}`, mode: 'insensitive' } },
      ]),
      { [column]: { contains: gate.inside, mode: 'insensitive' } },
    ]),
  };
}

/** [Review S3-2] A query whose every word is shorter than MIN_TERM_LENGTH
 *  ("A&W", "B&B", one typed letter) still searches: the whole trimmed text,
 *  as one exact piece, the way every door matched before. LIKE metacharacters
 *  are removed so nothing typed acts as a wildcard. Null when it holds no
 *  letter or digit at all. */
export function wholeQueryLiteral(q: string): string | null {
  const whole = q.normalize('NFC').trim().replace(/[%_\\]/g, '').slice(0, 200);
  return /[\p{L}\p{N}]/u.test(whole) ? whole : null;
}

/** A strictness level: must EVERY word match, and is one slip forgiven? */
export type Tier = { every: boolean; typos: boolean };

/**
 * The search tiers, strictest first. A caller runs them in order and stops
 * when its page is full, so a correctly typed word is never pushed down by a
 * slip match:
 *   1. every word, as typed (or its singular);
 *   2. every word, one slip forgiven;
 *   3. any word, as typed;       (only for a query of two or more words)
 *   4. any word, one slip forgiven.
 * A slip tier is skipped when no word is long enough for a slip or the
 * columns forgive none. Empty when the query has no searchable word.
 */
export function searchTiers(q: string, columns: SearchColumns): Array<{ tier: Tier; where: Where }> {
  const terms = searchTerms(q);
  if (terms.length === 0) {
    const whole = wholeQueryLiteral(q);
    if (whole === null) return [];
    return [{
      tier: { every: true, typos: false },
      where: {
        OR: [
          ...columns.text.map((column) => ({ [column]: { contains: whole, mode: 'insensitive' } })),
          ...(columns.lists ?? []).map((column) => ({ [column]: { hasSome: casings([whole.toLowerCase()]) } })),
        ],
      },
    }];
  }
  const plan = slipPlan(terms);
  const canSlip = (columns.typoText ?? []).length > 0 && plan.size > 0;
  const tiers: Tier[] = [
    { every: true, typos: false },
    ...(canSlip ? [{ every: true, typos: true }] : []),
    ...(terms.length > 1 ? [{ every: false, typos: false }] : []),
    ...(terms.length > 1 && canSlip ? [{ every: false, typos: true }] : []),
  ];
  return tiers.map((tier) => {
    const perTerm = terms.map((t) => termWhere(columns, t, tier.typos ? plan.get(t) ?? [] : []));
    return { tier, where: tier.every ? { AND: perTerm } : { OR: perTerm } };
  });
}

/** The in-memory twin of the column predicates for ONE text column: does
 *  `text` hold a literal form of any word anywhere, or (with `typos`) a slip
 *  form at the start of a word? `_` is exactly one character, as in SQL.
 *  Used to rank NAME matches above matches found only in a description. */
export function nameMatcher(q: string, typos: boolean): (text: string | null | undefined) => boolean {
  const terms = searchTerms(q);
  if (terms.length === 0) {
    const whole = wholeQueryLiteral(q)?.toLowerCase();
    return (text) => whole !== undefined && typeof text === 'string' && text.toLowerCase().includes(whole);
  }
  // forms hold letters, digits and `_` only, so nothing else needs escaping
  const literal = terms.flatMap(literalForms);
  const slips = typos ? [...slipPlan(terms).values()].flat().map((f) => f.replace(/_/g, '.')) : [];
  const re = new RegExp([...literal, ...slips.map((f) => `(?:^|\\s)${f}`)].join('|'), 'iu');
  return (text) => typeof text === 'string' && re.test(text);
}

/**
 * Fill a page from the tiers, strictest first, with the caller's LIVE gates
 * (launch market, listing rules) applied BEFORE counting toward the page —
 * never `take` a window and filter it afterwards, which left pages short or
 * empty while live matches sat just past the window.
 *
 * `fetch(where, take, deadline)` must AND `where` with the caller's own
 * visibility predicate. Rows already seen (returned by an earlier tier,
 * rejected by a gate, or passed in `exclude`) are never fetched again.
 *
 * [Review S2-1 · time bound] With `budgetMs`, the whole fill has that much
 * wall-clock time: `fetch` is handed the deadline (to tell the database to
 * stop the read there, search-budget.ts), and a read that fails with an error
 * `outOfTime` accepts — or a deadline reached between reads — ends the fill
 * with what the stricter tiers already found. Any other error is thrown.
 */
export async function fillFromTiers<Row extends { id: string }>(opts: {
  tiers: Array<{ tier: Tier; where: Where }>;
  fetch: (where: Where, take: number, deadline: number) => Promise<Row[]>;
  keep: (rows: Row[]) => Promise<Row[]> | Row[];
  limit: number;
  exclude?: Iterable<string>;
  /** Stable re-order inside one fetched window (e.g. name matches first). */
  rank?: (rows: Row[], tier: Tier) => Row[];
  window?: number;
  maxFetchesPerTier?: number;
  budgetMs?: number;
  outOfTime?: (err: unknown) => boolean;
  /** Called once when the fill ends for time (a log line, never the query). */
  onOutOfTime?: () => void;
}): Promise<Row[]> {
  const out: Row[] = [];
  const seen = new Set(opts.exclude ?? []);
  const window = opts.window ?? Math.min(Math.max(opts.limit * 3, 30), 150);
  const maxFetches = opts.maxFetchesPerTier ?? 3;
  const deadline = opts.budgetMs === undefined ? Number.POSITIVE_INFINITY : Date.now() + opts.budgetMs;
  for (const { tier, where } of opts.tiers) {
    for (let fetchNo = 0; fetchNo < maxFetches && out.length < opts.limit; fetchNo += 1) {
      if (Date.now() >= deadline) { opts.onOutOfTime?.(); return out; }
      const scoped = seen.size > 0 ? { AND: [where, { id: { notIn: [...seen] } }] } : where;
      let rows: Row[];
      try {
        rows = await opts.fetch(scoped, window, deadline);
      } catch (err) {
        if (opts.outOfTime?.(err)) { opts.onOutOfTime?.(); return out; }
        throw err;
      }
      for (const r of rows) seen.add(r.id);
      const ranked = opts.rank ? opts.rank(rows, tier) : rows;
      for (const r of await opts.keep(ranked)) {
        if (out.length >= opts.limit) break;
        out.push(r);
      }
      if (rows.length < window) break; // this tier has nothing more
    }
    if (out.length >= opts.limit) break;
  }
  return out;
}
