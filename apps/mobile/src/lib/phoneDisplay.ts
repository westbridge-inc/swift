/**
 * Format an E.164 number for a human to READ. Display only — never for storage,
 * comparison or dialling, all of which use the canonical `+5926001234` form the
 * server stores.
 *
 * A Guyanese number is 7 digits after +592 and is spoken as 3 + 4 ("two-two-five,
 * one-two-three-four"), so it is grouped that way. Anything that is not a
 * recognised shape is returned UNCHANGED rather than guessed at: a number a
 * customer is about to dial is the wrong place to invent spacing, and a wrong
 * grouping reads as a wrong number.
 */
export function formatPhoneForDisplay(e164: string | null | undefined): string {
  if (!e164) return '';
  const s = e164.trim();
  const m = /^\+592(\d{7})$/.exec(s);
  if (!m) return s;
  const n = m[1]!;
  return `+592 ${n.slice(0, 3)} ${n.slice(3)}`;
}
