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
export type AuditFacts = Readonly<Record<string, string | number | boolean | null>>;

/**
 * Invoked by a transaction-owning helper as the LAST statement inside its
 * transaction. If the callback throws — an audit row the database refuses —
 * the helper's own writes roll back with it. That is the contract: the change
 * and its record commit together or not at all.
 */
export type OnAudit = (tx: AuditLogWriter, facts: AuditFacts) => Promise<void>;
