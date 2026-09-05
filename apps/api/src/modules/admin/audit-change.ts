import { createHash } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import type { AdminRouteEntity } from './admin-authority';

/**
 * [ADM-004] THE AUDIT ROW SAYS WHAT CHANGED, NOT WHAT WAS ASKED.
 *
 * `changes` was `{ params, body }` — the request, with the body truncated at
 * 2,000 characters. Three things followed from that:
 *
 *   * An investigator could see that a route was CALLED and not what it DID.
 *     "PUT /subscriptions/:id/waive-fee was called" answers nothing about
 *     whether a fee was waived, on which period, or from what.
 *   * The truncation silently lost the tail of any large payload, so the part
 *     of the record most likely to matter was the part most likely to be cut.
 *   * A raw body carried document numbers, phone numbers and addresses into a
 *     table with no privacy shaping — a privacy problem created by the privacy
 *     control, and one that outlives the data it copied.
 *
 * The row now carries the subject's digest before and after, and a diff of the
 * declared fields. The digest covers the WHOLE row, so a change outside the
 * declared set still shows as a different digest; the diff is what a reader
 * sees first. No payload is stored at all.
 */

/** A row reduced to something stable and hashable: dates and Decimals become
 *  strings, keys are ordered, so an equal row always digests equal. */
function canonical(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  // [ADM-002] BigInt has no JSON form. Without this branch `JSON.stringify`
  // threw inside `snapshot()`, which swallowed it and returned ABSENT — so
  // every model with a BigInt column (AdRefundIntent.amountMinor) recorded a
  // null digest pair and an empty diff, silently, for as long as ADM-004 has
  // existed. A money amount is exactly the field the trail is for.
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value === 'object') {
    // Prisma Decimal and anything else that knows its own string form
    const asAny = value as { toFixed?: unknown; toString?: () => string };
    if (typeof asAny.toFixed === 'function') return String(value);
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, v]) => [key, canonical(v)]),
    );
  }
  return value;
}

/** The whole row, as one hash. A field nobody declared still moves this. */
export function digestOf(row: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonical(row))).digest('hex');
}

/** The declared fields, canonicalised, for the human-readable diff. */
export function declaredFields(row: unknown, fields: readonly string[]): Record<string, unknown> {
  const source = (row ?? {}) as Record<string, unknown>;
  return Object.fromEntries(fields.filter((f) => f in source).map((f) => [f, canonical(source[f])]));
}

export interface EntitySnapshot {
  readonly digest: string;
  readonly fields: Record<string, unknown>;
  readonly exists: boolean;
}

export const ABSENT: EntitySnapshot = { digest: '', fields: {}, exists: false };

/**
 * Read the subject row. A row that does not exist is a real answer — a created
 * entity has no before, a deleted one has no after — and is recorded as such
 * rather than as a missing field.
 */
export async function snapshot(
  prisma: PrismaClient,
  entity: AdminRouteEntity,
  id: string | undefined,
): Promise<EntitySnapshot> {
  if (!id) return ABSENT;
  const delegate = (prisma as unknown as Record<string, { findUnique?: (a: unknown) => Promise<unknown> }>)[entity.model];
  if (!delegate?.findUnique) return ABSENT;
  try {
    const where = entity.param === 'key' ? { key: id } : { id };
    const row = await delegate.findUnique({ where });
    if (!row) return ABSENT;
    return { digest: digestOf(row), fields: declaredFields(row, entity.fields), exists: true };
  } catch {
    // A model whose unique selector is not `id`/`key` is not a reason to lose
    // the audit row; the digests are simply absent and the trail says so.
    return ABSENT;
  }
}

export interface FieldChange { readonly from: unknown; readonly to: unknown }

/** What actually moved, among the declared fields. */
export function diffOf(before: EntitySnapshot, after: EntitySnapshot): Record<string, FieldChange> {
  const keys = new Set([...Object.keys(before.fields), ...Object.keys(after.fields)]);
  const changed: Record<string, FieldChange> = {};
  for (const key of keys) {
    const from = before.fields[key] ?? null;
    const to = after.fields[key] ?? null;
    if (JSON.stringify(from) !== JSON.stringify(to)) changed[key] = { from, to };
  }
  return changed;
}

/**
 * The `changes` column: what the action was aimed at, why, and what moved.
 * Deliberately never the request body — see the header.
 */
export function changeRecord(input: {
  params: Record<string, string>;
  reason: string | null;
  before: EntitySnapshot;
  after: EntitySnapshot;
  entityDeclared: boolean;
}): Record<string, unknown> {
  const { params, reason, before, after, entityDeclared } = input;
  const record: Record<string, unknown> = { params };
  if (reason) record['reason'] = reason;
  if (!entityDeclared) {
    // Named in ADMIN_ROUTES_WITHOUT_ENTITY: a backfill, a broadcast, a
    // versioned price book. Saying so is better than an empty digest pair that
    // reads as a failure to record.
    record['subject'] = 'no-single-row';
    return record;
  }
  record['before'] = before.exists ? before.digest : null;
  record['after'] = after.exists ? after.digest : null;
  record['changed'] = diffOf(before, after);
  return record;
}
