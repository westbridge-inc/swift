// ---------------------------------------------------------------------------
// [MISSION CONTROL · PR-1] THE RULES THE REASON PANEL CHECKS BEFORE IT SENDS.
//
// Each is the server's own rule, restated so the operator hears about it next
// to the field instead of as a refused request. reason-rules.test.ts reads the
// values from the API source, so the two cannot drift apart unnoticed:
//   - reason: apps/api/src/modules/admin/admin-authority.ts (reasonProblem)
//   - reference: apps/api/src/modules/money/evidence.ts (normaliseReference)
//   - amount ceiling: apps/api/src/utils/money-schema.ts (MONEY_MAX_WHOLE)
//
// One rule is the browser's, not the server's: the reason travels in the
// `x-swift-reason` HTTP header, and a header can only carry Latin-1. iPhone
// keyboards type ’ “ ” – — … by default, and `fetch` refuses a header holding
// any of them before a request is even sent — the click "did nothing". Those
// marks are sent as their plain equivalents; anything else that cannot travel
// (emoji, other scripts) is refused here, in words, before sending.
// ---------------------------------------------------------------------------

export const REASON_MIN = 12;
export const REASON_MAX = 500;

/** The server's TEMPLATE_REASONS: whole-reason matches, case-insensitive, trailing . or ! ignored. */
export const TEMPLATE_REASONS: readonly string[] = [
  'suspended by admin', 'banned by admin', 'cancelled by admin', 'waived by admin',
  'approved by admin', 'rejected by admin', 'resolved by admin', 'processed by admin',
  'admin action', 'no reason', 'n/a', 'none', 'test', 'testing', 'as discussed', 'per policy',
];

/** The server's money ceiling, whole GYD. */
export const MONEY_MAX_WHOLE = 99_999_999;

/** The server's reference shape: 4 to 64 characters, upper-case alphanumerics and . _ / - inside. */
export const REFERENCE_SHAPE = /^[A-Z0-9][A-Z0-9._/-]{2,62}[A-Z0-9]$/;

const TYPOGRAPHIC: ReadonlyArray<[RegExp, string]> = [
  [/[‘’‚‛′]/g, "'"],
  [/[“”„‟″]/g, '"'],
  [/[‐‑‒–—―−]/g, '-'],
  [/…/g, '...'],
  [/[       ]/g, ' '],
  [/[​‌‍⁠﻿]/g, ''],
];

/** Smart punctuation as its plain equivalent; nothing else is changed. */
export function plainPunctuation(text: string): string {
  return TYPOGRAPHIC.reduce((out, [from, to]) => out.replace(from, to), text);
}

/** True when every character can travel in an HTTP header (Latin-1, no control characters). */
export function headerSafe(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code > 0xff || code === 0x7f || (code < 0x20 && code !== 0x09)) return false;
  }
  return true;
}

export type ReasonProblem = 'missing' | 'too-short' | 'too-long' | 'template' | 'unsendable';
export type ReasonCheck = { ok: true; reason: string } | { ok: false; problem: ReasonProblem; message: string };

/** The reason as it will be sent, or what is wrong with it — in the server's words. */
/** The reason as it will travel: smart punctuation plain, line breaks as spaces (a header has none), trimmed. */
export function normaliseReason(raw: string): string {
  return plainPunctuation(raw).replace(/\s*[\r\n]+\s*/g, ' ').trim();
}

export function checkReason(raw: string): ReasonCheck {
  const reason = normaliseReason(raw);
  if (!reason) return { ok: false, problem: 'missing', message: 'Say why, in a sentence — the record keeps it.' };
  if (reason.length < REASON_MIN) {
    return { ok: false, problem: 'too-short', message: `Say why in at least ${REASON_MIN} characters — a word is not a reason anyone can review.` };
  }
  if (reason.length > REASON_MAX) return { ok: false, problem: 'too-long', message: `Keep the reason under ${REASON_MAX} characters.` };
  if (TEMPLATE_REASONS.includes(reason.toLowerCase().replace(/[.!]+$/, ''))) {
    return { ok: false, problem: 'template', message: 'That is the default text, not a reason. Say what actually happened.' };
  }
  if (!headerSafe(reason)) {
    return { ok: false, problem: 'unsendable', message: 'Use letters, numbers and ordinary punctuation — emoji and some symbols cannot be sent.' };
  }
  return { ok: true, reason };
}

export type FieldCheck<T> = { ok: true; value: T } | { ok: false; message: string };

/**
 * An amount in GYD, the way people type it ("4,500", "G$4,500", "$4500").
 * Exact or refused, never coerced: an empty box is not 0.
 */
export function parseAmountGyd(raw: string, options: { cents?: boolean } = {}): FieldCheck<number> {
  const text = raw.trim().replace(/^(?:GY?\$|\$)/i, '').replaceAll(',', '').trim();
  if (!text) return { ok: false, message: 'Enter the amount in GYD.' };
  const shape = options.cents ? /^\d+(\.\d{1,2})?$/ : /^\d+$/;
  if (!shape.test(text)) {
    return {
      ok: false,
      message: /^\d+\.\d+$/.test(text) && !options.cents
        ? 'Enter whole dollars (GYD has no cents here).'
        : 'That is not an amount. Use digits only, like 4500.',
    };
  }
  const value = Number(text);
  if (!Number.isFinite(value) || value <= 0) return { ok: false, message: 'The amount must be more than G$0.' };
  if (value > MONEY_MAX_WHOLE) return { ok: false, message: `The amount must be at most G$${MONEY_MAX_WHOLE.toLocaleString('en-GY')}.` };
  return { ok: true, value };
}

/** A transfer or receipt reference, stored as the server stores it: trimmed and upper-cased. */
export function checkReference(raw: string): FieldCheck<string> {
  const value = raw.trim().toUpperCase();
  if (!value) return { ok: false, message: 'Enter the reference — it is the only proof this happened.' };
  if (!REFERENCE_SHAPE.test(value)) {
    return { ok: false, message: 'That does not look like a reference: 4 to 64 letters and digits (. _ / - allowed inside), no spaces.' };
  }
  return { ok: true, value };
}
