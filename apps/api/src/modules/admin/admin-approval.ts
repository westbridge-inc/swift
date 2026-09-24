import { createHash } from 'node:crypto';
import type { Prisma, PrismaClient } from '@prisma/client';
import { ADMIN_ACTION_CLASSES, type AdminActionClass, type AdminRouteAuthority } from './admin-authority';

/**
 * [ADM-005] A MONEY ACTION TAKES TWO PEOPLE.
 *
 * Every `finance/*`, `billing/*`, `subscriptions/*` and `ads/*` money route
 * decided on ONE actor's request. A settlement processed, a fee waived, a
 * top-up granted or an invoice marked paid on one person's say-so — no
 * independent check, no reversal path, and (before ADM-006) not even a stated
 * reason. The one approval model that existed, `AgentActionRequest`, gates the
 * autonomous agent; no human action passed through anything like it.
 *
 * The class decides, as it does for the capability and the reason: C4 (money)
 * and C5 (platform) need a second capable admin. The record is a
 * `PrivilegedApproval` — what was asked, by whom, with what reason, over
 * exactly which request, and who else agreed.
 *
 * THE FINGERPRINT IS THE POINT. An approval is bound to the request that was
 * reviewed: method, route template, params and body, hashed. Change the
 * beneficiary, the amount or the target between the decision and the act and
 * the approval no longer matches — so "approved" can never be re-aimed at
 * something nobody read.
 */

/** How long a decision stays usable. Long enough to act on, short enough that
 *  an approval cannot be banked against a future, different situation. */
export const APPROVAL_TTL_MS = 24 * 60 * 60 * 1000;

export const APPROVAL_HEADER = 'x-swift-approval';

export type ApprovalStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'APPLIED' | 'EXPIRED';

export interface ApprovalSubject {
  readonly method: string;
  readonly routeUrl: string;
  readonly params: Record<string, unknown>;
  readonly body: unknown;
  /** The parsed query string. No C4/C5 route keys off it today (the DLQ
   *  identity guard is C3, so it never reaches apply), but it is part of WHAT
   *  EXECUTES — it is stored and fingerprinted exactly like the body, so a
   *  future route can never take a decision input here and have it silently
   *  dropped on replay. */
  readonly query?: Record<string, unknown>;
}

/**
 * The columns the apply path reads back from a stored approval row.
 *
 * `bodySnapshot` is added to the generated Prisma types when the client is
 * regenerated after the 20260924140000 migration; until then callers cast the
 * row to this shape, which is why it is spelled out rather than derived.
 */
export interface ApprovalSnapshotRow {
  readonly id: string;
  readonly action: string;
  readonly reason: string;
  readonly fingerprint: string;
  readonly status: string;
  /** The admin who asked; only they may apply it once approved. */
  readonly requestedBy: string;
  readonly appliedAt: Date | null;
  readonly bodySnapshot: Prisma.JsonValue | null;
}

/** Does this class need a second person at all? */
export function requiresApproval(cls: AdminActionClass): boolean {
  return ADMIN_ACTION_CLASSES[cls].requiresApproval;
}

/**
 * A stable hash of exactly what is being asked for.
 *
 * Key order cannot change the fingerprint (a client that serialises its body
 * differently is still asking for the same thing), but a changed VALUE always
 * does. The reason is deliberately excluded: an approver reads it, and a
 * requester who reworded their justification has not changed the act.
 */
export function fingerprintOf(subject: ApprovalSubject): string {
  const canonicalWithoutReason = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonicalWithoutReason);
    if (value && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
          .filter(([key]) => key !== 'reason')
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([key, v]) => [key, canonicalWithoutReason(v)]),
      );
    }
    return value;
  };
  const payload = JSON.stringify({
    method: subject.method.toUpperCase(),
    route: subject.routeUrl,
    params: canonicalWithoutReason(subject.params ?? {}),
    body: canonicalWithoutReason(subject.body ?? {}),
    query: canonicalWithoutReason(subject.query ?? {}),
  });
  return createHash('sha256').update(payload).digest('hex');
}

/**
 * [DS110-13] The reviewed request, reconstructed from what the row STORED.
 *
 * `action` carries "<METHOD> <route template>"; `bodySnapshot` carries the
 * canonical `{ params, body, query }` written at creation. The apply step replays
 * exactly this subject, and the fingerprint above is recomputed over it — so
 * the executed body is the displayed body, and any disagreement between the
 * two is refused rather than executed.
 */
export function approvalSubjectOf(approval: {
  action: string;
  bodySnapshot: Prisma.JsonValue | null;
}): ApprovalSubject | null {
  const [method, ...rest] = approval.action.split(' ');
  if (!method || rest.length === 0) return null;
  const snapshot = approval.bodySnapshot as { params?: Record<string, unknown>; body?: unknown } | null | undefined;
  return {
    method: method.toUpperCase(),
    routeUrl: rest.join(' '),
    params: snapshot?.params ?? {},
    body: snapshot?.body ?? {},
    query: (snapshot as { query?: Record<string, unknown> } | null | undefined)?.query ?? {},
  };
}

/** Substitute route params into a template: `/config/:key` + { key: 'X' } → `/config/X`. */
export function fillRouteTemplate(routeUrl: string, params: Record<string, unknown>): string {
  return routeUrl.replace(/:([A-Za-z0-9_]+)/g, (whole, name: string) => {
    const value = params[name];
    return value === undefined || value === null ? whole : encodeURIComponent(String(value));
  });
}

/** The stored query object back into a query string, for the apply replay.
 *  Repeated keys arrive as arrays from the parser and are re-emitted as
 *  arrays, so the replayed request parses to the identical value. */
export function queryStringOf(query: Record<string, unknown>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (Array.isArray(value)) {
      for (const item of value) search.append(key, String(item));
    } else if (value !== undefined && value !== null) {
      search.append(key, String(value));
    }
  }
  return search.toString();
}

/** The entity an action names, where its route names one. */
export function entityIdOf(params: Record<string, unknown>): string | null {
  for (const key of ['id', 'key', 'userId', 'subscriptionId', 'code', 'san', 'queue']) {
    const value = params[key];
    if (typeof value === 'string' && value) return value;
  }
  return null;
}

/**
 * The discriminant is `outcome`, not `kind`: `kind` is the word the mobile
 * notification census scans the API for, and a union that borrows it reads as
 * three new push kinds to a test whose whole job is to catch exactly that.
 */
export type ApprovalOutcome =
  | { outcome: 'not-required' }
  | { outcome: 'requested'; approvalId: string; fingerprint: string }
  | { outcome: 'granted'; approvalId: string }
  | { outcome: 'refused'; code: ApprovalRefusal; approvalId?: string };

export type ApprovalRefusal =
  | 'unknown-approval'
  | 'not-approved'
  | 'expired'
  | 'already-applied'
  | 'request-changed'
  | 'self-approval'
  | 'not-requester';

/** What the operator is told, in the terms of what they were trying to do. */
export function approvalRefusalMessage(code: ApprovalRefusal): string {
  switch (code) {
    case 'unknown-approval': return 'That approval does not exist. Request this action again to raise a new one.';
    case 'not-approved': return 'This action is waiting for a second admin to approve it.';
    case 'expired': return 'That approval has expired. Request the action again so someone reviews what you are asking for now.';
    case 'already-applied': return 'That approval has already been used. An approval authorises one act, not a standing permission.';
    case 'request-changed': return 'What you are asking for is not what was approved. Request it again so the change is reviewed.';
    case 'self-approval': return 'You approved this yourself. A money or platform action needs a second person.';
    case 'not-requester': return 'Only the admin who asked for this action can execute it, once a second admin has approved it.';
    default: {
      // [DS187] exhaustive by construction: a new refusal without a message is a compile error
      const unhandled: never = code;
      return unhandled;
    }
  }
}

/**
 * Resolve the approval for one request.
 *
 * With no approval id, the request itself is the ASK: a PENDING record is
 * written and the caller is told what to wait for. With one, it must be
 * presented by the requester, APPROVED, unexpired, unused, over this exact
 * request, and decided by someone other than the requester.
 */
export async function resolveApproval(
  prisma: PrismaClient,
  authority: AdminRouteAuthority,
  subject: ApprovalSubject,
  actor: { userId: string },
  approvalId: string | null,
  reason: string,
  now = new Date(),
): Promise<ApprovalOutcome> {
  if (!requiresApproval(authority.cls)) return { outcome: 'not-required' };
  const fingerprint = fingerprintOf(subject);

  if (!approvalId) {
    const data = {
      action: `${subject.method.toUpperCase()} ${subject.routeUrl}`,
      cls: authority.cls,
      capability: authority.capability,
      entityId: entityIdOf(subject.params),
      fingerprint,
      // [DS110-13] The request that executes and the request the approver
      // reads are ONE stored value: params, body and query, JSON-safe by
      // construction, round-trip unchanged through the JSONB column.
      bodySnapshot: { params: subject.params ?? {}, body: subject.body ?? {}, query: subject.query ?? {} },
      status: 'PENDING',
      requestedBy: actor.userId,
      reason,
      expiresAt: new Date(now.getTime() + APPROVAL_TTL_MS),
    };
    // `bodySnapshot` enters the generated client with the 20260924140000
    // migration; the assertion keeps this compiling against both generations.
    const created = await prisma.privilegedApproval.create({
      data: data as unknown as Prisma.PrivilegedApprovalUncheckedCreateInput,
      select: { id: true },
    });
    return { outcome: 'requested', approvalId: created.id, fingerprint };
  }

  const approval = await prisma.privilegedApproval.findUnique({ where: { id: approvalId } });
  if (!approval) return { outcome: 'refused', code: 'unknown-approval' };
  // Separation of duties, at the gate every route passes through: the admin
  // who ASKED spends the approval. Neither the approver nor a third admin can,
  // whether they come through POST /approvals/:id/apply or re-send the
  // original request with the approval header.
  if (approval.requestedBy !== actor.userId) return { outcome: 'refused', code: 'not-requester', approvalId };
  if (approval.status === 'APPLIED') return { outcome: 'refused', code: 'already-applied', approvalId };
  if (approval.status !== 'APPROVED') return { outcome: 'refused', code: 'not-approved', approvalId };
  if (approval.expiresAt.getTime() <= now.getTime()) return { outcome: 'refused', code: 'expired', approvalId };
  if (approval.fingerprint !== fingerprint) return { outcome: 'refused', code: 'request-changed', approvalId };
  // The approver is checked at the decision AND here: a record that somehow
  // carries the requester as its approver never authorises anything.
  if (!approval.approvedBy || approval.approvedBy === approval.requestedBy) {
    return { outcome: 'refused', code: 'self-approval', approvalId };
  }
  // Spent AT THE GATE, not after the act. Checking here and marking afterwards
  // leaves a window exactly as wide as the handler: two requests carrying the
  // same approval id would both read APPROVED, both proceed, and both pay —
  // and the record of one spend would be all that was left of it. The
  // compare-and-set is the authorisation, so exactly one request can hold it.
  //
  // A burnt approval on a failed act is the safe direction: someone reviews
  // the retry, rather than a retry inheriting a decision made about an attempt
  // that did not happen.
  if (!(await markApplied(prisma, approvalId, now))) {
    return { outcome: 'refused', code: 'already-applied', approvalId };
  }
  return { outcome: 'granted', approvalId };
}

/** The compare-and-set that IS the authorisation: APPROVED -> APPLIED, once. */
export async function markApplied(prisma: PrismaClient, approvalId: string, now = new Date()): Promise<boolean> {
  const spent = await prisma.privilegedApproval.updateMany({
    where: { id: approvalId, status: 'APPROVED' },
    data: { status: 'APPLIED', appliedAt: now },
  });
  return spent.count === 1;
}

export type DecisionRefusal = 'unknown' | 'self-approval' | 'already-decided' | 'expired' | 'missing-capability';

/**
 * A second admin decides. Two things are refused here rather than later: the
 * requester approving their own ask, and an approver who does not hold the
 * capability the action itself demands — an approval by someone who could not
 * perform the act is not an independent check, it is a signature.
 */
export async function decideApproval(
  prisma: PrismaClient,
  approvalId: string,
  decider: { userId: string; holds: (capability: string) => boolean },
  decision: { approve: boolean; note?: string },
  now = new Date(),
): Promise<{ ok: true; status: ApprovalStatus } | { ok: false; code: DecisionRefusal }> {
  const approval = await prisma.privilegedApproval.findUnique({ where: { id: approvalId } });
  if (!approval) return { ok: false, code: 'unknown' };
  if (approval.status !== 'PENDING') return { ok: false, code: 'already-decided' };
  if (approval.expiresAt.getTime() <= now.getTime()) {
    await prisma.privilegedApproval.updateMany({ where: { id: approvalId, status: 'PENDING' }, data: { status: 'EXPIRED' } });
    return { ok: false, code: 'expired' };
  }
  if (approval.requestedBy === decider.userId) return { ok: false, code: 'self-approval' };
  if (!decider.holds(approval.capability)) return { ok: false, code: 'missing-capability' };

  const status: ApprovalStatus = decision.approve ? 'APPROVED' : 'REJECTED';
  const decided = await prisma.privilegedApproval.updateMany({
    where: { id: approvalId, status: 'PENDING' },
    data: { status, approvedBy: decider.userId, decisionNote: decision.note ?? null, decidedAt: now },
  });
  if (decided.count !== 1) return { ok: false, code: 'already-decided' };
  return { ok: true, status };
}
