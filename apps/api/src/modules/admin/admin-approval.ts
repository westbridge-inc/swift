import { createHash } from 'node:crypto';
import type { Prisma, PrismaClient } from '@prisma/client';
import { ADMIN_ACTION_CLASSES, type AdminActionClass, type AdminRouteAuthority } from './admin-authority';
import { lockCreditRefundAsks, PAID_ACTION, validatePaidAsk } from '../billing/credit-refund';
import { SOLO_ROLE, isSoleApprover } from './solo-approval';

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

/** CANCELLED: the requester withdrew it [OWNER #13]. */
export type ApprovalStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'APPLIED' | 'EXPIRED' | 'CANCELLED';

/** [Owner, admin-staging 25 Oct] Statuses a request can still move from: past its expiry each one is EXPIRED. */
const LAPSES: readonly string[] = ['PENDING', 'APPROVED'];

/** What a request IS now: an open one past its expiry is EXPIRED, whatever its column still says. */
export function effectiveApprovalStatus(row: { status: string; expiresAt: Date }, now: Date): string {
  return LAPSES.includes(row.status) && row.expiresAt.getTime() <= now.getTime() ? 'EXPIRED' : row.status;
}

/** The rows of one approvals view, by the status each row IS now (effectiveApprovalStatus). */
export function approvalsViewWhere(view: ApprovalStatus, now: Date): Prisma.PrivilegedApprovalWhereInput {
  if (LAPSES.includes(view)) return { status: view, expiresAt: { gt: now } };
  if (view === 'EXPIRED') return { OR: [{ status: 'EXPIRED' }, { status: { in: [...LAPSES] }, expiresAt: { lte: now } }] };
  return { status: view };
}

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
  | { outcome: 'refused'; code: ApprovalRefusal; approvalId?: string }
  /** [U06] An earlier ask for the same act still stands: nothing new was written. */
  | { outcome: 'already-open'; approvalId: string; status: OpenApprovalStatus; askedByYou: boolean };

export type ApprovalRefusal =
  | 'unknown-approval'
  | 'not-approved'
  | 'expired'
  | 'already-applied'
  | 'request-changed'
  | 'self-approval'
  | 'not-requester'
  /** [OWNER #13] Approved in solo mode, but the owner is no longer the only
   *  admin who could approve it: the second admin decides (no grandfathering). */
  | 'solo-ended';

/**
 * [U06] ONE ASK PER ACT WHILE IT STANDS.
 *
 * The console showed the 202 as nothing (or as a failure), the operator
 * pressed again, and every press wrote another PENDING row for the same act.
 * Two approvers each approving "their" copy would make it happen twice: a
 * payment returned twice, a broadcast sent twice.
 *
 * An ask still STANDS while it waits for a second admin (PENDING) or is
 * approved and not yet executed (APPROVED), until it expires. While one
 * stands, a new ask for the same ACTION on the same TARGET is refused —
 * whoever asks, whatever the body says (a changed amount is a different
 * answer to the same question: withdraw the first, then ask again). The
 * target is the route's params; a route with no params (a broadcast, a new
 * promo) has no target of its own, so the exact request (its fingerprint)
 * stands in for one. Executing an approved ask is never refused by this.
 */
export const OPEN_APPROVAL_STATUSES = ['PENDING', 'APPROVED'] as const;
export type OpenApprovalStatus = (typeof OPEN_APPROVAL_STATUSES)[number];

function canonicalParams(params: Record<string, unknown>): string {
  return JSON.stringify(Object.keys(params).sort().map((key) => [key, params[key] === undefined || params[key] === null ? null : String(params[key])]));
}

/** The key two asks for one act share: the action plus its target. */
export function askTargetKey(subject: ApprovalSubject, fingerprint: string): string {
  const params = subject.params ?? {};
  const target = Object.keys(params).length > 0 ? `params:${canonicalParams(params)}` : `request:${fingerprint}`;
  return `${subject.method.toUpperCase()} ${subject.routeUrl} ${target}`;
}

type StandingAsk = { id: string; status: OpenApprovalStatus; requestedBy: string };
// What the ask transaction found: the ask already standing, or the one it wrote.
// `askState` (not `kind`): the notification censuses read `kind:` literals as notification kinds.
type AskResult = { askState: 'standing'; standing: StandingAsk } | { askState: 'created'; created: { id: string } };

/** The ask for this act that still stands, if any. Call under the ask lock. */
async function standingAskFor(
  db: Prisma.TransactionClient,
  subject: ApprovalSubject,
  fingerprint: string,
  now: Date,
): Promise<StandingAsk | null> {
  const action = `${subject.method.toUpperCase()} ${subject.routeUrl}`;
  const params = subject.params ?? {};
  const hasTarget = Object.keys(params).length > 0;
  const rows = await db.privilegedApproval.findMany({
    where: {
      action,
      status: { in: [...OPEN_APPROVAL_STATUSES] },
      expiresAt: { gt: now },
      ...(hasTarget ? { entityId: entityIdOf(params) } : { fingerprint }),
    },
    select: { id: true, status: true, requestedBy: true, bodySnapshot: true },
    orderBy: { createdAt: 'asc' },
  });
  const wanted = canonicalParams(params);
  const match = rows.find((row) => {
    if (!hasTarget) return true;
    const stored = (row.bodySnapshot as { params?: Record<string, unknown> } | null)?.params;
    return !!stored && typeof stored === 'object' && canonicalParams(stored) === wanted;
  });
  return match ? { id: match.id, status: match.status as OpenApprovalStatus, requestedBy: match.requestedBy } : null;
}

/** [U06] What the operator is told when their ask already stands. */
export function alreadyOpenMessage(status: OpenApprovalStatus, askedByYou: boolean): string {
  if (status === 'APPROVED') {
    // Only the admin who asked can apply it (separation of duties), so a
    // different admin is told who must act rather than told to apply it.
    return askedByYou
      ? 'You already have this approved. Apply it from Approvals. Nothing new was asked.'
      : 'Another admin already has this approved and waiting to be applied by them from Approvals. Nothing new was asked.';
  }
  return askedByYou
    ? 'This is already waiting for a second admin in Approvals. Nothing new was asked. To ask for something different, cancel that request first.'
    : 'Another admin already asked for this, and it is waiting in Approvals. Nothing new was asked.';
}

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
    case 'solo-ended': return 'This was approved in solo mode, but a second admin who can approve it now exists. Ask for the action again so they decide it.';
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
  actor: { userId: string; role?: string | undefined },
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
    const write = (db: Prisma.TransactionClient | PrismaClient) => db.privilegedApproval.create({
      data: data as unknown as Prisma.PrivilegedApprovalUncheckedCreateInput,
      select: { id: true },
    });
    // [DS1122 S1] A refund payout-record ask is the "payout reported" marker:
    // it is written under that refund's ask lock, so a release applying at the
    // same moment either sees it or has finished before it.
    const refundEntity = data.action === PAID_ACTION ? data.entityId : null;
    const asked: AskResult = await prisma.$transaction(async (tx): Promise<AskResult> => {
      if (refundEntity) await lockCreditRefundAsks(tx, refundEntity);
      // [U06] One ask per act: two presses racing both wait here, and the
      // second sees the first's row.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`privileged-approval-ask:${askTargetKey(subject, fingerprint)}`}, 0))`;
      const standing = await standingAskFor(tx, subject, fingerprint, now);
      if (standing) return { askState: 'standing', standing };
      // [Review S2-1] Checked before it is written: an ask that could never be recorded is
      // refused now and never becomes a "payout reported" marker.
      if (refundEntity) await validatePaidAsk(tx, refundEntity, subject.body);
      return { askState: 'created', created: await write(tx) };
    });
    if (asked.askState === 'standing') {
      const { standing } = asked;
      return { outcome: 'already-open', approvalId: standing.id, status: standing.status, askedByYou: standing.requestedBy === actor.userId };
    }
    return { outcome: 'requested', approvalId: asked.created.id, fingerprint };
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
  // carries the requester as its approver never authorises anything — unless
  // it was decided in SOLO MODE [OWNER #13], and even then only while the
  // requester is still the owner and still the ONLY admin who could approve
  // it, counted again now. A second admin appearing between the solo decision
  // and this moment voids it: they decide (no grandfathering).
  if (!approval.approvedBy) return { outcome: 'refused', code: 'self-approval', approvalId };
  if (approval.approvedBy === approval.requestedBy) {
    if (!(approval as { decidedSolo?: boolean }).decidedSolo) return { outcome: 'refused', code: 'self-approval', approvalId };
    if (actor.role !== SOLO_ROLE || !(await isSoleApprover(prisma, actor.userId, approval.capability))) {
      return { outcome: 'refused', code: 'solo-ended', approvalId };
    }
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
    // [Owner, admin-staging 25 Oct] The expiry is part of the compare-and-set too: a lapsed approval never spends.
    where: { id: approvalId, status: 'APPROVED', expiresAt: { gt: now } },
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
    // [Owner, admin-staging 25 Oct] Decided only while still inside its time, checked in the write itself.
    where: { id: approvalId, status: 'PENDING', expiresAt: { gt: now } },
    data: { status, approvedBy: decider.userId, decisionNote: decision.note ?? null, decidedAt: now },
  });
  if (decided.count !== 1) return { ok: false, code: 'already-decided' };
  return { ok: true, status };
}
