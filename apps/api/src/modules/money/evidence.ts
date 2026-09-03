import { AppError } from '../../utils/errors';

// ---------------------------------------------------------------------------
// MONEY EVIDENCE — the shared shape of "this payment really happened".
//
// Swift closes several money obligations on MANUAL rails: a store attesting an
// MMG payment, a rider and a store confirming a cash handover, an admin paying
// a reimbursement claim, an admin settling a refund. In every one of them the
// only proof that will ever exist is what a person types in afterwards.
//
// Those surfaces each learned the same three lessons separately. This module is
// them, stated once, so a surface built later inherits them rather than
// re-deriving them:
//
//   1. A REFERENCE IS EVIDENCE ONLY IF IT IS UNIQUE. Otherwise one string
//      closes ten obligations and a reused or invented one reads exactly like a
//      real one. Uniqueness lives in the database; normalisation lives here, so
//      the same transfer typed two ways cannot occupy two rows and defeat it.
//
//   2. THE PAYER STATES THE AMOUNT. A reference alone says nothing about the
//      figure, so an obligation could close for a fraction of its value and the
//      record would look identical.
//
//   3. MONEY IS PARSED EXACTLY OR REFUSED. `Number('')` and `Number([])` are
//      both 0, and a zero that nobody typed is the most dangerous figure there
//      is.
// ---------------------------------------------------------------------------

/**
 * Alphanumeric with the separators real bank and MMG references use, no leading
 * or trailing punctuation. The quantifier IS the length bound: 1 + 2..62 + 1
 * means 4 to 64 characters.
 */
const REFERENCE_SHAPE = /^[A-Z0-9][A-Z0-9._/-]{2,62}[A-Z0-9]$/;

export interface ReferenceMessages {
  /** Shown when the field is empty — "enter it". */
  required: string;
  /** Shown when something was entered but is not a reference — "not that". */
  invalid: string;
}

/**
 * The reference as it will be stored: trimmed and upper-cased. Nothing entered
 * and something wrong are different mistakes, and the person is told which.
 */
export function normaliseReference(raw: unknown, messages: ReferenceMessages, codePrefix = 'REFERENCE'): string {
  const value = typeof raw === 'string' ? raw.trim().toUpperCase() : '';
  if (value.length === 0) {
    throw new AppError(400, `${codePrefix}_REQUIRED`, messages.required);
  }
  if (!REFERENCE_SHAPE.test(value)) {
    throw new AppError(400, `${codePrefix}_INVALID`, messages.invalid);
  }
  return value;
}

/**
 * The amount this value really is, or null. Accepts a finite number, a Prisma
 * `Decimal` (which crosses the wire as a STRING), or a string that is exactly a
 * decimal literal. Everything else is null — no coercion, ever.
 */
export function parseExactAmount(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'object' && value !== null && 'toString' in value) {
    const parsed = Number((value as { toString(): string }).toString());
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!/^-?\d+(\.\d+)?$/.test(trimmed)) return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

export interface AmountMessages {
  /** Shown when no figure was stated at all. */
  required: string;
  /** Built when the stated figure is not the owed one. */
  mismatch: (_owed: number, _stated: number) => string;
  /** Shown when the obligation's own amount cannot be read. */
  unreadable: string;
}

/**
 * The payer states what they sent, and it must be the obligation's own figure
 * to the cent. Returns the attested amount so the caller can record it.
 */
export function assertAmountAttested(
  owedRaw: unknown,
  statedRaw: unknown,
  messages: AmountMessages,
  codePrefix = 'AMOUNT',
): number {
  const owed = parseExactAmount(owedRaw);
  const stated = parseExactAmount(statedRaw);
  if (stated === null) throw new AppError(400, `${codePrefix}_REQUIRED`, messages.required);
  if (owed === null) throw new AppError(409, `${codePrefix}_UNREADABLE`, messages.unreadable);
  // Cents, so 4500 and "4500.00" agree and 4500.01 does not.
  if (Math.round(owed * 100) !== Math.round(stated * 100)) {
    throw new AppError(409, `${codePrefix}_MISMATCH`, messages.mismatch(owed, stated));
  }
  return stated;
}

/** A Prisma unique-constraint violation on a named column, recognised. */
export function isDuplicateOn(err: unknown, field: string): boolean {
  const e = err as { code?: string; meta?: { target?: unknown } };
  if (e?.code !== 'P2002') return false;
  const target = Array.isArray(e.meta?.target) ? e.meta?.target.join(',') : String(e.meta?.target ?? '');
  return target.includes(field);
}
