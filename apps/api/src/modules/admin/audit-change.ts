import { createHash, createHmac } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { SNAPSHOT_UNIQUE_FIELDS, type AdminRouteEntity } from './admin-authority';
import { adminAuditSnapshotCounter } from '../../plugins/observability';
import { getTenantId } from '../../plugins/tenant-context';
import { isProduction } from '../../utils/runtime-mode';

/**
 * [ZONE-FARES] The tenant predicate for an entity walled only through its
 * parents (`tenantVia`): every named relation's `tenantId` is the caller's.
 * `null` means "read nothing" — no tenant is bound, so no row can be proven
 * the caller's. `{}` means the entity declares no such wall.
 */
export function tenantPredicateOf(entity: Pick<AdminRouteEntity, 'tenantVia'>, tenantId: string | null = getTenantId()): Record<string, unknown> | null {
  if (!entity.tenantVia || entity.tenantVia.length === 0) return {};
  if (!tenantId) return null;
  return Object.fromEntries(entity.tenantVia.map((relation) => [relation, { tenantId }]));
}

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

/** The whole row, as one hash. A field nobody declared still moves this.
 *  (Also the value identity money-surface.ts stores and compares; the audit snapshot uses snapshotDigestOf.) */
export function digestOf(row: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonical(row))).digest('hex');
}

/**
 * [SEC-PII · security scan 28 Oct 2026] THE COLUMNS AN AUDIT SNAPSHOT NEVER COVERS.
 *
 * The snapshot digest was a plain SHA-256 over the whole row, secrets included, and every other column of
 * the row is readable elsewhere in the console: a 6-digit custody transfer code (or a pickup code, a ride
 * PIN) was the only unknown left, so anyone who could read the trail could recompute the digest for every
 * candidate and recover the live code offline. These columns are removed from the row before it is
 * digested, and from the declared diff. ONE list for every audited model: a new secret column is added
 * here (the census test checks each name is a real column and that no audited entity declares one).
 *
 * Rows already in the trail are never rewritten (append-only). Codes whose old digests sit in it are an
 * operations matter (rotate the live ones), not something this code can undo.
 */
export const SNAPSHOT_SECRET_FIELDS = [
  // one-use hand-off codes and their guess counters (a counter narrows the code's guess space)
  'transferCode', 'pickupCode', 'ridePin', 'pickupCodeAttempts', 'ridePinAttempts',
  // what the order showed the customer to pay into (a store's MMG number / pay link at order time)
  'mmgNumberSnapshot', 'mmgPayUrlSnapshot',
  // credentials and bearer values
  'passwordHash', 'paymentToken', 'courierTrackingToken', 'stateHash', 'hostedUrl',
] as const;
const SECRET_FIELD_SET: ReadonlySet<string> = new Set(SNAPSHOT_SECRET_FIELDS);

function withoutSecrets(row: unknown): unknown {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return row;
  return Object.fromEntries(Object.entries(row as Record<string, unknown>).filter(([key]) => !SECRET_FIELD_SET.has(key)));
}

/**
 * The snapshot digest's key: derived (HMAC, its own label) from the server's JWT_SECRET, which the boot
 * guard already requires in production and no admin can read. No new secret to set. A keyed digest also
 * means no OTHER low-entropy column (a phone number, a coordinate) can be guessed back from the trail.
 * Outside production without the secret, a fixed local key (tests and local development only).
 */
function snapshotDigestKey(): Buffer {
  const secret = process.env['JWT_SECRET'];
  if (!secret) {
    if (isProduction()) throw new Error('JWT_SECRET is required in production');
    return createHmac('sha256', 'swift-local-audit-digest-key-not-for-production').update('swift:admin-audit-snapshot:v1').digest();
  }
  return createHmac('sha256', secret).update('swift:admin-audit-snapshot:v1').digest();
}

/** The audit snapshot's digest: the row without its secret columns, keyed. Every other column still moves it. */
export function snapshotDigestOf(row: unknown): string {
  return createHmac('sha256', snapshotDigestKey()).update(JSON.stringify(canonical(withoutSecrets(row)))).digest('hex');
}

/** The declared fields, canonicalised, for the human-readable diff. */
export function declaredFields(row: unknown, fields: readonly string[]): Record<string, unknown> {
  const source = (row ?? {}) as Record<string, unknown>;
  // [SEC-PII] A secret column never reaches the diff, whatever an entity declares.
  return Object.fromEntries(fields.filter((f) => f in source && !SECRET_FIELD_SET.has(f)).map((f) => [f, canonical(source[f])]));
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
  // [review] Both of these used to return ABSENT silently. The second is
  // exactly what a renamed or mistyped `model` produces — the same shape as
  // C-01 — so a metric whose contract says "non-zero `failed` means digests are
  // missing" was one-sided: zero did not mean they were present.
  if (!id) {
    adminAuditSnapshotCounter.labels('no_id', entity.model).inc();
    return ABSENT;
  }
  const delegate = (prisma as unknown as Record<string, { findUnique?: (a: unknown) => Promise<unknown> }>)[entity.model];
  if (!delegate?.findUnique) {
    adminAuditSnapshotCounter.labels('no_delegate', entity.model).inc();
    return ABSENT;
  }
  // [C-01] The column, not the route parameter. `where` was built as
  // `entity.param === 'key' ? { key: id } : { id }`, which asked DocType — a
  // model with no `id` column at all — for `where: { id: 'GY.national_id' }`.
  // Prisma refused, the catch below swallowed the refusal, and the audit row
  // for permitting a personal document to leave the country carried a null
  // before, a null after and an empty diff.
  const field = entity.uniqueField ?? 'id';
  if (!SNAPSHOT_UNIQUE_FIELDS.includes(field)) {
    // Unreachable through the type, reachable through a hand-edited table.
    // Counted rather than thrown: the trail loses a digest, never an action.
    adminAuditSnapshotCounter.labels('selector', entity.model).inc();
    return ABSENT;
  }
  const walled = tenantPredicateOf(entity);
  if (walled === null) {
    adminAuditSnapshotCounter.labels('no_tenant', entity.model).inc();
    return ABSENT;
  }
  try {
    const row = await delegate.findUnique({ where: { [field]: id, ...walled } });
    if (!row) {
      adminAuditSnapshotCounter.labels('missing', entity.model).inc();
      return ABSENT;
    }
    adminAuditSnapshotCounter.labels('found', entity.model).inc();
    return { digest: snapshotDigestOf(row), fields: declaredFields(row, entity.fields), exists: true };
  } catch {
    // [C-01] A swallowed read is how this defect lived: ABSENT is
    // indistinguishable from "the row genuinely does not exist". It stays
    // swallowed — an audit read must never roll back the action it describes —
    // but it is now a NUMBER someone can alert on, not a silence.
    adminAuditSnapshotCounter.labels('failed', entity.model).inc();
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
