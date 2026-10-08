import { needsProfanityHold } from '../rating/review-scrub';

export type ChatContentReason = 'LANGUAGE' | 'PHONE' | 'LINK';

// Whole candidates, never substring exceptions. The send schema bounds text
// to 2,000 characters. Alphanumeric order references are not phone numbers.
// A hyphen before the digits does not hide a number ("call-6001000"); a
// digit or letter does (order references, part numbers).
const PHONE = /(?<![\p{L}\p{N}])\+?\d(?:[\s().-]*\d){6,}(?![\p{L}\p{N}])/gu;
// A bare address ("shop.gy", "t.me/x") is a link only when it ends in a web
// suffix people actually use. Two words joined by a dot ("11.am", "I.am",
// "do.it", "come.to") are ordinary chat, so the ambiguous two-letter suffixes
// that are also English words are deliberately not on this list.
const TLDS = [
  'com', 'net', 'org', 'info', 'biz', 'io', 'co', 'app', 'dev', 'xyz', 'online', 'site', 'shop', 'store', 'icu',
  'me', 'ly', 'gg', 'tv', 'cc', 'ws', 'gy', 'tt', 'bb', 'jm', 'lc', 'vc', 'gd', 'ag', 'dm', 'kn', 'bs', 'ky', 'tc',
  'vg', 'sr', 'uk', 'ca', 'ru', 'cn', 'de', 'fr',
].join('|');
const LINK = new RegExp(
  '(?:https?|ftp|file|mailto|tel|sms|javascript|data):[^\\s<>{}]+'
  + '|www\\.[^\\s<>{}]+'
  + '|[\\p{L}\\p{N}._%+-]+@[\\p{L}\\p{N}-]+(?:\\.[\\p{L}\\p{N}-]+)+'
  + `|(?:[\\p{L}\\p{N}][\\p{L}\\p{N}-]{0,62}\\.)+(?:${TLDS})(?![\\p{L}\\p{N}-])(?:[/:?#][^\\s<>{}]*)?`
  // Any dotted host followed by a path is an address, whatever its suffix.
  + '|(?:[\\p{L}\\p{N}][\\p{L}\\p{N}-]{0,62}\\.)+\\p{L}{2,63}/[^\\s<>{}]*',
  'giu',
);
const ORDER_REFERENCE_PREFIX = /SW-$/i;
const SUPPORT_PHONES = new Set(['5927163534', '7163534']);

function isSupportLink(candidate: string): boolean {
  try {
    const url = new URL(candidate);
    return url.protocol === 'https:' && url.hostname === 'swiftgy.com'
      && !url.username && !url.password && !url.port && !url.search && !url.hash
      && (url.pathname === '/contact' || url.pathname === '/contact/');
  } catch {
    return false;
  }
}

function isCalendarDate(year: number, month: number, day: number): boolean {
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

/** A real calendar date: ISO year-month-day, or Guyana's day-month-year with - or . */
function isDate(candidate: string): boolean {
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(candidate);
  if (iso) return isCalendarDate(Number(iso[1]), Number(iso[2]), Number(iso[3]));
  const dmy = /^(\d{1,2})([-.])(\d{1,2})\2(\d{4})$/.exec(candidate);
  return dmy ? isCalendarDate(Number(dmy[4]), Number(dmy[3]), Number(dmy[1])) : false;
}

/** Admission only: preserve allowed original text; never log rejected text. */
export function chatContentReason(message: string): ChatContentReason | undefined {
  const text = message.normalize('NFKC').replace(/\p{Cf}/gu, '');
  if (needsProfanityHold(text)) return 'LANGUAGE';
  for (const match of text.matchAll(LINK)) {
    const candidate = match[0].replace(/[.,!?;:)\]}'"]+$/u, '');
    if (!isSupportLink(candidate)) return 'LINK';
  }
  for (const match of text.matchAll(PHONE)) {
    const candidate = match[0];
    if (SUPPORT_PHONES.has(candidate.replace(/\D/g, '')) || isDate(candidate)) continue;
    // Swift's own order reference: SW-YYMMDD-NNNXXX, whose suffix can be all digits.
    if (ORDER_REFERENCE_PREFIX.test(text.slice(Math.max(0, match.index - 3), match.index)) && /^\d{6}-\d{6}$/.test(candidate)) continue;
    // Explicit currency amounts remain ordinary conversation, including an
    // ungrouped amount. A currency exception cannot contain phone separators.
    const prefix = text.slice(Math.max(0, match.index - 5), match.index);
    // At most nine digits: a ten-digit "+592" number is never an amount.
    if (/(?:GYD|\$)\s*$/i.test(prefix) && /^\d{1,9}(?:\.\d{2})?$/.test(candidate)) continue;
    return 'PHONE';
  }
  return undefined;
}
