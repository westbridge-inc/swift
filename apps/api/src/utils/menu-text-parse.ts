// ---------------------------------------------------------------------------
// [NO-AI] MENU TEXT -> DRAFT ROWS, DETERMINISTICALLY.
//
// Menu PDF import used to send the extracted text to a model and ask it to
// return structured items. Swift now contains no model runtime, so the same
// job is done by reading what is actually on the page.
//
// This parser is deliberately CONSERVATIVE. A menu line that does not clearly
// carry a name and a price is skipped, not guessed at: the vendor confirms
// every row in the existing preview step, so a miss costs them one typed line
// while an invention costs them a wrong price on a live product. It never
// decides a price, a category name, or an availability — it only reads.
//
// Shapes it handles, which is what a menu PDF's text layer actually looks like:
//
//     Chicken Curry ................ 1500
//     Chicken Curry                $1,500.00
//     2. Fish & Chips   G$2,250
//     Pepperpot (served with bread) ..... 1800
//
// Price-LAST is the rule. A line whose description follows the price
// ("Pepperpot  1800  (served with bread)") is NOT read — TRAILING_PRICE
// anchors at end of line — and is left for the vendor rather than guessed at.
//     STARTERS                      <- a category header: no price, short
// ---------------------------------------------------------------------------

export interface MenuDraft {
  category: string;
  name: string;
  description: string;
  basePrice: number;
}

/** The largest price a menu line may legitimately carry (GYD). Above this it is a phone number, a year, or a mistake. */
const MAX_PRICE = 10_000_000;
const MIN_PRICE = 1;
/**
 * A BARE integer — no currency mark, no thousands separator, no decimals, no
 * dotted leader — is almost never a price, AT ANY MAGNITUDE. This used to be a
 * floor: a naked number under 50 was rejected, anything above it accepted. That
 * inverted the module's own rule for exactly the lines a menu footer is full of,
 * because the numbers in them are large:
 *
 *     "Call us on 592 226 1234"        -> item "Call us on 592 226"  @ 1234
 *     "Established 1998"               -> item "Established"         @ 1998
 *     "Serving Georgetown since 1998"  -> item "Serving Georgetown since" @ 1998
 *     "Table 100"                      -> item "Table"               @ 100
 *
 * A Guyanese phone number written the ordinary way sailed straight through; only
 * the unseparated form ever hit MAX_PRICE. So the magnitude escape hatch is
 * gone: a number is a price when the line SHOWS it is money, and otherwise it is
 * left for the vendor. A genuinely $5 item written "$5" or "5.00" still reads.
 * That is the trade this file already argued for — a skipped line costs one
 * typed row, an invented one puts a wrong price on a live product.
 *
 * The floor is KEPT for the weakest signal — a plain column gap — because that
 * is where "Chapter   5" and "Page   2" live. It is no longer the whole rule.
 */
const BARE_INTEGER_FLOOR = 50;
const MAX_NAME = 150;
const MAX_DESCRIPTION = 500;
const MAX_CATEGORY = 80;

/** A trailing money token: optional currency mark, digits with , or space groups, optional decimals. */
const TRAILING_PRICE = /(?:^|[\s.·…-])((?:G?\$|GYD|\$)?)\s*(\d{1,3}(?:[,\s]\d{3})+|\d+)(?:\.(\d{1,2}))?\s*$/;
/** Leading list numbering a menu often carries: "1.", "12)", "-", "•". */
const LEADING_ORNAMENT = /^\s*(?:\d{1,3}\s*[.)\]]|[-–—•*·])\s*/;
/** Dotted or dashed leaders between a name and its price. */
const LEADERS = /[\s.·…_-]{2,}$/;

const clean = (s: string) => s.replace(/\s+/g, ' ').trim();

/** A parenthesised or dash-led tail is the item's description, not part of its name. */
function splitNameAndDescription(raw: string): { name: string; description: string } {
  const paren = raw.match(/^(.*?)\s*[([]([^)\]]{2,})[)\]]\s*$/);
  if (paren && clean(paren[1] ?? '')) {
    return { name: clean(paren[1]!).slice(0, MAX_NAME), description: clean(paren[2]!).slice(0, MAX_DESCRIPTION) };
  }
  const dash = raw.match(/^(.{2,}?)\s+[–—-]\s+(.{2,})$/);
  if (dash) {
    return { name: clean(dash[1]!).slice(0, MAX_NAME), description: clean(dash[2]!).slice(0, MAX_DESCRIPTION) };
  }
  return { name: clean(raw).slice(0, MAX_NAME), description: '' };
}

/**
 * A line with no price MAY be a category header. Only if it is short, carries
 * letters, and is not obviously prose — a sentence is a stray paragraph, not a
 * heading, and treating it as one would file every following item under it.
 */
function asCategoryHeader(line: string): string | null {
  const text = clean(line.replace(LEADING_ORNAMENT, ''));
  if (text.length < 2 || text.length > MAX_CATEGORY) return null;
  if (!/[A-Za-z]/.test(text)) return null;
  if (/[.!?;:]$/.test(text)) return null;
  if (text.split(' ').length > 5) return null;
  const isShouted = text === text.toUpperCase();
  const isTitle = /^[A-Z]/.test(text) && text.split(' ').every((w) => /^[^a-z]|^[A-Z]/.test(w) || w.length <= 3);
  return isShouted || isTitle ? text : null;
}

/** Read a menu's text layer into draft rows. Never throws; an unreadable menu yields []. */
export function parseMenuText(text: string, opts: { defaultCategory?: string } = {}): MenuDraft[] {
  const drafts: MenuDraft[] = [];
  let category = opts.defaultCategory ?? 'Menu';

  for (const rawLine of String(text ?? '').split(/\r?\n/)) {
    // A PDF text layer is full of non-breaking and narrow spaces; normalise
    // them so the price and leader patterns below see ordinary whitespace.
    const line = rawLine.replace(/[\u00a0\u202f\u2007]/g, ' ').trimEnd();
    if (!clean(line)) continue;

    const priceMatch = line.match(TRAILING_PRICE);
    if (!priceMatch) {
      const header = asCategoryHeader(line);
      if (header) category = header;
      continue;
    }

    const currency = priceMatch[1] ?? '';
    const digits = priceMatch[2] ?? '';
    const cents = priceMatch[3] ?? '';
    const whole = digits.replace(/[,\s]/g, '');
    const basePrice = Number(cents ? `${whole}.${cents}` : whole);
    if (!Number.isFinite(basePrice) || basePrice < MIN_PRICE || basePrice > MAX_PRICE) continue;

    const rawBefore = line.slice(0, priceMatch.index ?? 0);
    // Does the line SHOW that this number is money?
    // The gap between the name and the price. TRAILING_PRICE consumes the
    // separator itself, so most of it lives in the MATCH, not in rawBefore —
    // reading only rawBefore misses the column gap entirely and rejects the
    // commonest menu shape of all ("Real Item   900").
    const gap = (/[\s.·…_-]*$/.exec(rawBefore)?.[0] ?? '') + (/^[\s.·…_-]*/.exec(priceMatch[0])?.[0] ?? '');
    // Does the line SHOW that this number is money? A column gap, a dotted
    // leader, a currency mark, decimals, or thousands grouping. A single space
    // is none of those — it is just the next word.
    // Three strengths of signal, and they are not interchangeable.
    //  STRONG  — a currency mark, decimals, or thousands grouping. Unambiguous.
    //  LEADER  — a dotted/dashed run, an explicit menu convention.
    //  GAP     — plain whitespace of two or more. The weakest, and the one a
    //            spaced number sequence or a column of prose also produces.
    const strongMoney = Boolean(currency) || Boolean(cents) || /[,\s]/.test(digits);
    // A leader is a RUN. One hyphen is punctuation inside a token, not a menu
    // convention — "WhatsApp orders 592-600-1234" is the case that proves it.
    const leaderMoney = gap.length >= 2 && /[.·…_-]/.test(gap);
    const gapMoney = gap.length >= 2;
    if (!strongMoney && !leaderMoney && !gapMoney) continue;

    const beforePrice = rawBefore.replace(LEADERS, '');
    if (!strongMoney && !leaderMoney) {
      // Carried only by a column gap. Two things are then still not prices:
      // a small naked number ("Chapter   5", "Page   2"), and a number that
      // continues the name's own digits ("Call us on 592 226   1234").
      if (basePrice < BARE_INTEGER_FLOOR) continue;
      if (/\d$/.test(beforePrice)) continue;
    }
    const withoutOrnament = beforePrice.replace(LEADING_ORNAMENT, '');
    const { name, description } = splitNameAndDescription(withoutOrnament);
    // A price with no name is a subtotal, a page number, or a stray column.
    if (!name || !/[A-Za-z]/.test(name)) continue;

    drafts.push({ category: category.slice(0, MAX_CATEGORY) || 'Menu', name, description, basePrice });
  }

  return drafts;
}
