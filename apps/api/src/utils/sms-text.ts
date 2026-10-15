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
