// ---------------------------------------------------------------------------
// [ADM-002] THE AUDIT ROW JOINS THE TRANSACTION THAT OWNS THE CHANGE.
//
// Most money helpers already open their own `$transaction` — the price book,
// promo terms, bank reconciliation, the USD migration. A route that calls one
// of them cannot hand `auditWithin` a transaction it does not hold. Threading
// a `tx` through every caller would rewrite who owns the transaction; instead
// the helper accepts an OPTIONAL callback and invokes it as the LAST statement
// inside the transaction it already owns. The route supplies the callback;
// the helper supplies the client and the facts only it knows (the version it
// recorded, the deposit it confirmed). Neither learns the other's shape.
//
// This file lives in `lib/` so a helper in `modules/country/` or
// `modules/billing/` never imports the ADMIN module to describe a writer.
// ---------------------------------------------------------------------------

/**
 * The narrowest thing that can write an audit row: satisfied by `PrismaClient`
 * and by the `tx` a `$transaction` callback receives. Structural on purpose —
 * a transaction client is not assignable to `PrismaClient`, and the whole
 * point is that the CALLER decides which one it is.
 */
export interface AuditLogWriter {
  readonly auditLog: {
    create(args: { data: Record<string, unknown> }): Promise<unknown>;
  };
}

/**
 * Named facts a helper hands to the audit row — the version it wrote, what
 * it restored from, the amount it confirmed. Scalars only: a fact, never a
 * payload. (ADM-004 removed request bodies from the trail for privacy; this
 * is not the way back in.)
 */
export const RESERVED_AUDIT_FIELDS = ['params', 'reason', 'subject', 'before', 'after', 'changed'] as const;
export type ReservedAuditField = (typeof RESERVED_AUDIT_FIELDS)[number];

/**
 * [C-01b] The canonical names are REFUSED AT COMPILE TIME, not at request time.
 *
 * `adminAuditRow` throws a TypeError when `extra` carries one of these — the
 * right call, because a fact silently replacing the stated reason or a
 * before/after digest is a falsified trail. But the throw happens inside the
 * action's transaction, so the whole request 500s, and NOTHING executed these
 * routes: their tests called the service directly with a stub audit callback.
 * Two live privileged routes were therefore total failures on main —
 *
 *   PUT /verification/doc-types/:code/external-processing   (the residency decision)
 *   PUT /cash-rules/rlp/movers/:userId/suspend              (loss-protection suspension)
 *
 * — each passing its own `reason` as a "fact" alongside the canonical one. The
 * `never` below turns that from a 500 nobody ran into a build nobody can merge.
 */
export type AuditFacts =
  // `| undefined` in the index signature so SPREADING an AuditFacts into a new
  // facts literal still type-checks: the spread carries the optional reserved
  // keys along as `undefined`, and a strict `string | number | boolean | null`
  // signature would reject its own output.
  Readonly<Record<string, string | number | boolean | null | undefined>> &
  Partial<Readonly<Record<ReservedAuditField, never>>>;

/**
 * Invoked by a transaction-owning helper as the LAST statement inside its
 * transaction. If the callback throws — an audit row the database refuses —
 * the helper's own writes roll back with it. That is the contract: the change
 * and its record commit together or not at all.
 */
export type OnAudit = (tx: AuditLogWriter, facts: AuditFacts) => Promise<void>;
