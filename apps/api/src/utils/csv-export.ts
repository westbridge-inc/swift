/**
 * [MASTER-038] The one CSV export boundary for spreadsheet-bound files.
 *
 * A CSV cell is data, but a spreadsheet opening the file reads a cell that
 * starts with `=`, `+`, `-` or `@` (also after leading whitespace or control
 * characters such as tab, carriage return or line feed) as a FORMULA. Any
 * text that came from outside — a name, a reference, a channel, an
 * identifier — therefore goes through `csvText`, which:
 *
 *  1. neutralises formula-leading text by prefixing an apostrophe (the
 *     documented convention: the cell shows the text, with the apostrophe
 *     visible to a plain CSV reader), and then
 *  2. quotes the cell per RFC 4180 when it holds a delimiter, a quote, a line
 *     break, a tab, or leading/trailing spaces (doubling inner quotes).
 *
 * Validated numbers and ISO dates the server formats itself are written as
 * they are (`csvRow` takes them as already-safe strings via `csvNumber`), so
 * a legitimate negative amount keeps its numeric type. Stored values are never
 * changed: this is output encoding for one context only.
 */
const FORMULA_CHARS = new Set(['=', '+', '-', '@']);
const NEEDS_QUOTES = /[",\r\n\t]|^\s|\s$/;

/** Whitespace or an ASCII control character (code 0x00–0x20). */
const isBlankOrControl = (ch: string): boolean => ch.charCodeAt(0) <= 0x20 || /\s/.test(ch);

/** A cell a spreadsheet could read as a formula: it starts with a tab, CR or
 *  LF, or its first character after any leading whitespace/control
 *  characters is = + - or @. */
function formulaLeading(value: string): boolean {
  const first = value[0]!;
  if (first === '\t' || first === '\r' || first === '\n') return true;
  let i = 0;
  while (i < value.length && isBlankOrControl(value[i]!)) i += 1;
  return i < value.length && FORMULA_CHARS.has(value[i]!);
}

export function csvText(value: string | null | undefined): string {
  if (value === null || value === undefined || value === '') return '';
  const inert = formulaLeading(value) ? `'${value}` : value;
  return NEEDS_QUOTES.test(inert) ? `"${inert.replace(/"/g, '""')}"` : inert;
}

/** A server-validated number, written as a plain numeric cell. */
export function csvNumber(value: number, fractionDigits = 2): string {
  if (!Number.isFinite(value)) throw new Error('csvNumber: not a finite number');
  return value.toFixed(fractionDigits);
}
