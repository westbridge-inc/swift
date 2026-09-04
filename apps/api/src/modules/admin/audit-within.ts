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
// the migration lands, and a route that regresses puts it back up.
//
// The row is built by ONE function for both writers. The trail does not change
// shape when a route migrates; only the moment it is written does.
// ---------------------------------------------------------------------------

import { ABSENT, changeRecord, snapshot, type EntitySnapshot } from './audit-change';
import { ADMIN_ROUTE_AUTHORITY, reasonOf, routeTemplateOf } from './admin-authority';

/**
 * The narrowest thing that can write the row: satisfied by `PrismaClient` and
 * by the `tx` a `$transaction` callback receives. Typing it structurally is
 * deliberate — the point of this module is that the CALLER decides which of
 * those it is, and a transaction client is not assignable to `PrismaClient`.
 */
export interface AuditLogWriter {
  readonly auditLog: {
    create(args: { data: Record<string, unknown> }): Promise<unknown>;
  };
}

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
}

export interface AdminAuditRowInput {
  /** The mounted path, as the trail has always recorded it. */
  readonly routeUrl: string;
  readonly reason: string | null;
  readonly before: EntitySnapshot;
  readonly after: EntitySnapshot;
  readonly entityDeclared: boolean;
  /** [ADM-007] The audited READS file under `integrity`, not the path root. */
  readonly entityOverride?: string | undefined;
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
  return {
    userId,
    action: `ADMIN ${request.method} ${input.routeUrl}`,
    entity: input.entityOverride ?? (input.routeUrl.split('/').filter(Boolean)[0] ?? 'admin'),
    entityId: params['id'] ?? params['key'] ?? params['userId'] ?? '-',
    changes: changeRecord({
      params,
      reason: input.reason,
      before: input.before,
      after: input.after,
      entityDeclared: input.entityDeclared,
    }),
    ipAddress: request.ip,
    userAgent: headers['user-agent'],
  };
}

/** Where the audit row for this request came from. */
export type AuditWriterKind = 'inline' | 'backstop';

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
  overrides?: { readonly userId?: string | undefined; readonly reason?: string | null | undefined },
): Promise<void> {
  const userId = overrides?.userId ?? request.user?.userId;
  // No actor, no row worth writing. The hook makes the same call, so this is
  // not a new way to lose a row.
  if (!userId) return;
  const routeUrl = request.routeOptions?.url ?? request.url;
  const authority = ADMIN_ROUTE_AUTHORITY[`${request.method.toUpperCase()} ${routeTemplateOf(request as never, prefix)}`];
  const params = (request.params ?? {}) as Record<string, string>;
  const entity = authority?.entity;
  const after = entity
    ? await snapshot(tx as never, entity, params[entity.param ?? 'id'])
    : ABSENT;
  await tx.auditLog.create({
    data: adminAuditRow(request, userId, {
      routeUrl,
      reason: overrides?.reason !== undefined ? overrides.reason : reasonOf(request.body, request.headers as never),
      before: request.auditBefore ?? ABSENT,
      after,
      entityDeclared: !!entity,
    }),
  });
  request.auditWrittenInline = true;
}

/** Did this request's action write its own audit row inside its transaction? */
export function wroteAuditInline(request: AuditRequestLike): boolean {
  return request.auditWrittenInline === true;
}

export { ABSENT };
