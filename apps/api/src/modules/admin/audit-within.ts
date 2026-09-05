// ---------------------------------------------------------------------------
// [ADM-002] THE AUDIT ROW IS WRITTEN INSIDE THE ACTION, NOT AFTER IT.
//
// The admin trail was written by an `onResponse` hook. By the time that hook
// runs, the action has committed AND the response has been sent — so the only
// thing a failed audit write could do was this:
//
//     } catch (err) {
//       app.log.error({ err }, '[admin-audit] failed to write audit log');
//     }
//
// A log line. Database contention, a validation error on the audit row, or a
// process exit between commit and hook, and a privileged action — a refund
// settled, a fee waived, a price book replaced — completed with no record of
// it. The failure mode is the worst kind: discoverable only by absence, and
// only if someone thought to look for a row that was never there.
//
// The fix is not a retry, a queue or a louder log. It is that the audit row
// and the change it describes must succeed or fail TOGETHER. `auditWithin`
// writes the row through the caller's transaction client, so a refused audit
// row rolls the action back with it. The action stops being auditable-in-
// principle and becomes unperformable-without-audit.
//
// WHY THE HOOK STAYS. 40 C4/C5 routes need this and they do not all own their
// mutation — 8 go entirely through BillingService / CashRulesService /
// SubscriptionService, and those need a transaction arc through the service
// before a route can hand one to `auditWithin`. Deleting the hook now would
// take the trail off every route not yet migrated. So it stays as a BACKSTOP,
// and `adminAuditCounter` says which writer produced each row: `inline` for a
// row inside its action's transaction, `backstop` for one the hook wrote
// because nothing else did. "Backstop is the only writer" is the observability
// the clause asks for, and it is a number, not a guess — it goes to zero as
// the migration lands, and a route that regresses puts it back up. A fourth
// label, `refused`, counts an INLINE row the database would not take — the
// action rolled back with it, which is the fix working, but it must still be
// a number someone can alert on rather than an anonymous 500.
//
// The row is built by ONE function for both writers. The trail does not change
// shape when a route migrates; only the moment it is written does.
// ---------------------------------------------------------------------------

import { ABSENT, changeRecord, snapshot, type EntitySnapshot } from './audit-change';
import type { PrismaClient } from '@prisma/client';
import type { AuditLogWriter } from '../../lib/audit-writer';
import { ADMIN_ROUTE_AUTHORITY, reasonOf, routeTemplateOf } from './admin-authority';
import { adminAuditCounter } from '../../plugins/observability';

// The writer type lives in `lib/audit-writer.ts` so transaction-owning money
// helpers can accept an `onAudit` callback without importing this module.
export type { AuditLogWriter, AuditFacts, OnAudit } from '../../lib/audit-writer';

/** The fields of a Fastify request the audit row is built from. */
export interface AuditRequestLike {
  readonly method: string;
  readonly url: string;
  readonly routeOptions?: { readonly url?: string | undefined } | undefined;
  readonly params?: unknown;
  readonly body?: unknown;
  readonly ip?: string | undefined;
  readonly headers?: Record<string, unknown> | undefined;
  readonly user?: { readonly userId?: string | undefined } | undefined;
  auditBefore?: EntitySnapshot | undefined;
  auditWrittenInline?: boolean | undefined;
  /** [ADM-002] The id of the row `auditWithin` wrote, so the hook can verify
   *  that what it is asked to trust actually committed. */
  auditInlineRowId?: string | undefined;
}

/** The keys `changeRecord` owns. `extra` may add to `changes`; it may never
 *  redefine one of these, because a route that did so would silently replace
 *  the stated reason, or the before/after digests, with its own idea of them. */
export const RESERVED_CHANGE_KEYS: ReadonlySet<string> = new Set(['params', 'reason', 'subject', 'before', 'after', 'changed']);

export interface AdminAuditRowInput {
  /** The mounted path, as the trail has always recorded it. */
  readonly routeUrl: string;
  /** [ADM-002] The route TEMPLATE with the mount prefix stripped (`/promos/:id`).
   *  `entity` is its first segment — the resource the action was aimed at.
   *  Without it the column was derived from the MOUNTED path, and every admin
   *  row said `api`: a column that named nothing. Only the audited READS
   *  override it (`integrity`, ADM-007). */
  readonly template?: string | undefined;
  readonly reason: string | null;
  readonly before: EntitySnapshot;
  readonly after: EntitySnapshot;
  readonly entityDeclared: boolean;
  /** [ADM-007] The audited READS file under `integrity`, not the path root. */
  readonly entityOverride?: string | undefined;
  /** [ADM-002] A CREATE route has no id in its params — the subject did not
   *  exist when the request was routed. Without this the row says `-` and the
   *  trail cannot name what was created. */
  readonly entityIdOverride?: string | undefined;
  /** [ADM-002] NAMED facts a route's own audit row carried that the generic
   *  one cannot derive — `POST /notifications/broadcast` records how many
   *  people it reached, and its whole subject IS the audience.
   *
   *  Explicit fields ONLY. ADM-004 stripped the raw request body out of
   *  `changes` because it carried document numbers, phone numbers and
   *  addresses into a table with no privacy shaping; spreading a payload
   *  through here would put it straight back. A count, a role, a version — not
   *  `...body`. */
  readonly extra?: Readonly<Record<string, string | number | boolean | null>> | undefined;
}

/**
 * ONE row shape, both writers. The hook and `auditWithin` call this so a route
 * that migrates writes exactly the row it wrote before — same action name,
 * same entity, same change record — at a different moment.
 */
export function adminAuditRow(
  request: AuditRequestLike,
  userId: string,
  input: AdminAuditRowInput,
): Record<string, unknown> {
  const params = (request.params ?? {}) as Record<string, string>;
  const headers = request.headers ?? {};
  const extra = input.extra ?? {};
  const collision = Object.keys(extra).find((key) => RESERVED_CHANGE_KEYS.has(key));
  if (collision) {
    // A programming error at the call site, surfaced where the test for that
    // route will see it — never a quietly rewritten trail.
    throw new TypeError(`[ADM-002] audit extra may not redefine the canonical field '${collision}'`);
  }
  const resource = input.template?.split('/').filter(Boolean)[0];
  return {
    userId,
    action: `ADMIN ${request.method} ${input.routeUrl}`,
    entity: input.entityOverride ?? resource ?? (input.routeUrl.split('/').filter(Boolean)[0] ?? 'admin'),
    entityId: input.entityIdOverride ?? params['id'] ?? params['key'] ?? params['userId'] ?? '-',
    // Named extras first, the canonical record last: even if the guard above
    // were ever bypassed, the reason and the digests are the ones that stand.
    changes: {
      ...extra,
      ...changeRecord({
        params,
        reason: input.reason,
        before: input.before,
        after: input.after,
        entityDeclared: input.entityDeclared,
      }),
    },
    ipAddress: request.ip,
    userAgent: headers['user-agent'],
  };
}

/** Where the audit row for this request came from. */
export type AuditWriterKind = 'inline' | 'backstop' | 'failed' | 'refused' | 'rolled-back';

/**
 * Write the audit row through the caller's transaction, and mark the request
 * so the backstop hook does not write a second one.
 *
 * Call it INSIDE `prisma.$transaction`, after the mutation:
 *
 *     await app.prisma.$transaction(async (tx) => {
 *       const row = await tx.platformConfig.upsert({ ... });
 *       await auditWithin(tx, request, app.prefix);
 *       return row;
 *     });
 *
 * If the audit row is refused, the transaction throws and the upsert never
 * commits — which is the whole point.
 *
 * It derives the route, the action class, the reason and the subject snapshots
 * exactly as the hook does, from the same authority table, so a migrated route
 * needs no per-route audit arguments to keep the trail identical. 40 C4/C5
 * routes have to adopt this; a call that took six arguments would be forty
 * chances to pass a different one.
 *
 * The `after` snapshot is read through `tx`, so it sees the uncommitted change
 * — the row as the action leaves it, which is what the trail should say.
 *
 * The marker is set only after the write resolves, so a failed audit leaves
 * the request unmarked and the hook still covers it if the action survived.
 */
export async function auditWithin(
  tx: AuditLogWriter,
  request: AuditRequestLike,
  prefix: string,
  overrides?: {
    readonly userId?: string | undefined;
    readonly reason?: string | null | undefined;
    /** [ADM-002] The id of a row this action CREATED. A create route has no id
     *  in its params, so without it the audit row cannot name its subject. */
    readonly entityId?: string | undefined;
    /** [ADM-002] Named facts the generic row cannot derive. Explicit fields
     *  only — never a request-body spread (see `AdminAuditRowInput.extra`). */
    readonly extra?: Readonly<Record<string, string | number | boolean | null>> | undefined;
  },
): Promise<void> {
  const userId = overrides?.userId ?? request.user?.userId;
  // No actor, no row worth writing. The hook makes the same call, so this is
  // not a new way to lose a row.
  if (!userId) return;
  const routeUrl = request.routeOptions?.url ?? request.url;
  const template = routeTemplateOf(request as never, prefix);
  const authority = ADMIN_ROUTE_AUTHORITY[`${request.method.toUpperCase()} ${template}`];
  const params = (request.params ?? {}) as Record<string, string>;
  const entity = authority?.entity;
  const after = entity
    ? await snapshot(tx as never, entity, params[entity.param ?? 'id'])
    : ABSENT;
  let row: unknown;
  try {
    row = await tx.auditLog.create({
      data: adminAuditRow(request, userId, {
        routeUrl,
        template,
        reason: overrides?.reason !== undefined ? overrides.reason : reasonOf(request.body, request.headers as never),
        before: request.auditBefore ?? ABSENT,
        after,
        entityDeclared: !!entity,
        entityIdOverride: overrides?.entityId,
        extra: overrides?.extra,
      }),
    });
  } catch (err) {
    // The transaction is about to roll back — that is the clause working. But
    // an inline refusal surfaces to the client as a 500 with nothing naming
    // the audit write as the cause, and the hook never sees it (it leaves on
    // any 4xx/5xx). Count it here or it is invisible.
    adminAuditCounter.labels('refused', authority?.cls ?? 'C0').inc();
    throw err;
  }
  request.auditWrittenInline = true;
  const id = (row as { id?: unknown } | null)?.id;
  request.auditInlineRowId = typeof id === 'string' ? id : undefined;
}

export type InlineRowVerdict = 'present' | 'absent' | 'unknown';

/**
 * [ADM-002] Did the row the action says it wrote actually COMMIT?
 *
 * `auditWithin` sets its marker inside the transaction, after the INSERT
 * resolves but before COMMIT. Between those two moments the transaction can
 * still fail — and if the route catches that failure and answers 2xx anyway,
 * the request arrives at the hook marked "audited" with no row behind it. A
 * hook that trusted the marker would then write nothing, and the one action
 * this clause exists to record would be the one with no record.
 *
 * So the hook verifies before it trusts: one primary-key read, after the
 * response has been sent, so it costs the caller nothing. `absent` is the only
 * verdict that makes the hook write; a read that FAILED proves nothing about
 * the row and must not become a duplicate.
 */
export async function verifyInlineRow(prisma: PrismaClient, request: AuditRequestLike): Promise<InlineRowVerdict> {
  const id = request.auditInlineRowId;
  if (!id) return 'unknown';
  try {
    const row = await prisma.auditLog.findUnique({ where: { id }, select: { id: true } });
    return row ? 'present' : 'absent';
  } catch {
    return 'unknown';
  }
}

/** Did this request's action write its own audit row inside its transaction? */
export function wroteAuditInline(request: AuditRequestLike): boolean {
  return request.auditWrittenInline === true;
}

export { ABSENT };
