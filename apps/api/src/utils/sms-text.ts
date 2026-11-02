/**
 * SMS text limits [R20 / research B10].
 *
 * A text written only in the GSM 03.38 alphabet carries 160 characters in one
 * part and 153 in each part of a longer message. ONE character outside it (an
 * em dash, a curly quote, an emoji, most accented letters) re-encodes the whole
 * message as UCS-2: 70 characters per part, 67 when split. A 200-character
 * notice then costs four parts instead of two, and some carriers drop long
 * concatenations. Texts Swift composes stay inside the GSM alphabet, and any
 * person-supplied piece (a first name) is cleaned before it goes in.
 */

/** GSM 03.38 basic set, minus the three control characters (LF, CR, ESC). */
const GSM7_BASIC = new Set(
  '@£$¥èéùìòÇØøÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà',
);
/** Characters that need the escape prefix: each counts as two. */
const GSM7_EXTENDED = new Set('^{}\\[~]|€');

/** Single-part limit and per-part limit of a concatenated GSM-7 text. */
export const GSM7_SINGLE = 160;
export const GSM7_PART = 153;

/** True when every character of `text` is in the GSM alphabet (basic or extended). */
export function isGsm7(text: string): boolean {
  for (const ch of text) {
    if (!GSM7_BASIC.has(ch) && !GSM7_EXTENDED.has(ch)) return false;
  }
  return true;
}

/** Septets the text occupies (an extended character costs two). Infinity when not GSM-7. */
export function gsm7Length(text: string): number {
  let n = 0;
  for (const ch of text) {
    if (GSM7_BASIC.has(ch)) n += 1;
    else if (GSM7_EXTENDED.has(ch)) n += 2;
    else return Number.POSITIVE_INFINITY;
  }
  return n;
}

/** How many parts the text is sent as (GSM-7 only; Infinity otherwise). */
export function gsm7Parts(text: string): number {
  const n = gsm7Length(text);
  if (!Number.isFinite(n)) return n;
  return n <= GSM7_SINGLE ? 1 : Math.ceil(n / GSM7_PART);
}

/**
 * A person's name made safe to put in a text: letters outside the GSM alphabet
 * fall back to their base letter where there is one (ā → a), anything else is
 * dropped, whitespace collapses, and the result is cut to `max` characters.
 * Returns '' when nothing usable is left — the caller supplies its own words.
 */
export function gsm7Name(raw: string | null | undefined, max: number): string {
  if (!raw) return '';
  let out = '';
  for (const ch of raw.normalize('NFC')) {
    if (GSM7_BASIC.has(ch)) { out += ch; continue; }
    if (/\s/.test(ch)) { out += ' '; continue; }
    const base = ch.normalize('NFD').replace(/\p{M}+/gu, '');
    if (base.length === 1 && GSM7_BASIC.has(base)) out += base;
  }
  return out.replace(/ +/g, ' ').trim().slice(0, max).trim();
}

// ---------------------------------------------------------------------------
// [SMS-COST · owner ruling 2 Nov 2026] Every text Swift sends is GSM-7.
//
// One on-call re-page carried "UNACKNOWLEDGED (16×)": the "×" alone re-encoded
// the whole text as UCS-2, so a 480-character page went out as 8 paid parts
// instead of 4 (and the words it repeated did not need to be texted at all).
// The SMS providers (providers/notifications/channels.ts) pass EVERY body
// through `gsm7Sms` before it leaves Swift, so no sender can pay for UCS-2
// again; senders still write GSM-7 words themselves (sms-every-text-gsm7.test).
// ---------------------------------------------------------------------------

/** Look-alikes outside the GSM basic set, written the way a person would type them in plain text. */
const GSM7_LOOKALIKES: Readonly<Record<string, string>> = {
  '\u2018': "'", '\u2019': "'", '\u201a': "'", '\u201b': "'", '\u2032': "'", '`': "'", '\u00b4': "'",
  '\u201c': '"', '\u201d': '"', '\u201e': '"', '\u2033': '"', '\u00ab': '"', '\u00bb': '"',
  '\u2010': '-', '\u2011': '-', '\u2012': '-', '\u2013': '-', '\u2014': '-', '\u2015': '-', '\u2212': '-',
  '~': '-', '\u2022': '-', '\u00b7': '-',
  '\u2026': '...',
  '\u00d7': 'x', '\u2715': 'x', '\u2716': 'x',
  '\u2192': '->', '\u2190': '<-', '\u21d2': '=>',
  '\u2265': '>=', '\u2264': '<=',
  '[': '(', ']': ')', '{': '(', '}': ')',
  '|': '/', '\\': '/',
  '\u20ac': 'EUR',
};

/** The text, reduced to the GSM-7 basic set: whitespace becomes one space,
 *  look-alikes are mapped (× → x, — → -, curly quotes → straight), accented
 *  letters lose an accent GSM-7 lacks, and anything else (emoji, other
 *  scripts, ^) is dropped. The extension table (^ { } \ [ ~ ] | €) costs two
 *  septets and some phones render it badly, so it is mapped or dropped too. */
export function toGsm7(text: string): string {
  let out = '';
  for (const ch of text) {
    if (/\s/u.test(ch)) { out += ' '; continue; }
    const mapped = GSM7_LOOKALIKES[ch];
    if (mapped !== undefined) { out += mapped; continue; }
    if (GSM7_BASIC.has(ch)) { out += ch; continue; }
    for (const part of ch.normalize('NFD').replace(/\p{M}/gu, '')) {
      if (GSM7_BASIC.has(part)) out += part;
    }
  }
  return out.replace(/ {2,}/g, ' ').trim();
}

/** True when the text uses only the GSM basic set (no extension table, no line breaks). */
export function isGsm7Basic(text: string): boolean {
  for (const ch of text) if (!GSM7_BASIC.has(ch)) return false;
  return true;
}

/** True when the whole message can travel as GSM-7: the basic set, the extension table, and line breaks. */
export function isGsm7Message(text: string): boolean {
  for (const ch of text) {
    if (ch !== '\n' && ch !== '\r' && !GSM7_BASIC.has(ch) && !GSM7_EXTENDED.has(ch)) return false;
  }
  return true;
}

/**
 * [SMS-COST] What an SMS provider sends. A message that is already GSM-7 goes
 * out EXACTLY as written (a sign-in code text is never touched); any other is
 * rewritten line by line with `toGsm7`, so it can never be billed as UCS-2.
 */
export function gsm7Sms(body: string): string {
  if (isGsm7Message(body)) return body;
  return body.split(/\r\n|\r|\n/).map(toGsm7).join('\n');
}

/**
 * [SMS-COST] A GSM-7 text cut to at most `maxParts` parts: unchanged when it
 * already fits, else shortened at a word and ended with "...". Put what the
 * reader must have first: the end is what is cut.
 */
export function fitGsm7(text: string, maxParts: number): string {
  if (gsm7Parts(text) <= maxParts) return text;
  const budget = (maxParts <= 1 ? GSM7_SINGLE : maxParts * GSM7_PART) - 3;
  let cut = '';
  let used = 0;
  for (const ch of text) {
    const cost = GSM7_EXTENDED.has(ch) ? 2 : 1;
    if (used + cost > budget) break;
    cut += ch; used += cost;
  }
  const atWord = cut.replace(/\s+\S*$/u, '');
  return `${(atWord.length >= cut.length / 2 ? atWord : cut).replace(/[\s,.;:-]+$/u, '')}...`;
}
