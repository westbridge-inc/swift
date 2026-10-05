import { needsProfanityHold } from '../rating/review-scrub';

export type ChatContentReason = 'LANGUAGE' | 'PHONE' | 'LINK';

// Whole candidates, never substring exceptions. The send schema bounds text
// to 2,000 characters. Alphanumeric order references are not phone numbers.
const PHONE = /(?<![\p{L}\p{N}-])\+?\d(?:[\s().-]*\d){6,}(?![\p{L}\p{N}])/gu;
const LINK = /(?:https?|ftp|file|mailto|tel|sms|javascript|data):[^\s<>{}]+|www\.[^\s<>{}]+|(?:[\p{L}\p{N}][\p{L}\p{N}-]{0,62}\.)+[\p{L}]{2,63}(?:[/:?#][^\s<>{}]*)?/giu;
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

function isDate(candidate: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(candidate)) return false;
  const date = new Date(candidate + 'T00:00:00Z');
  return Number.isFinite(date.getTime()) && date.toISOString().startsWith(candidate);
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
    // Explicit currency amounts remain ordinary conversation, including an
    // ungrouped amount. A currency exception cannot contain phone separators.
    const prefix = text.slice(Math.max(0, match.index - 5), match.index);
    if (/(?:GYD|\$)\s*$/i.test(prefix) && /^\d+(?:\.\d{2})?$/.test(candidate)) continue;
    return 'PHONE';
  }
  return undefined;
}
