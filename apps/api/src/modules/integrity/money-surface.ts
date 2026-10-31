import { createHash } from 'node:crypto';
import type { Prisma, PrismaClient } from '@prisma/client';
import type { Server } from 'socket.io';
import type Redis from 'ioredis';
import { algoConfig } from '../algo/algo-config';
import { recordDecision } from '../algo/decisions';
import { hasStepUp } from '../auth/step-up';
import { NotificationService } from '../notification/notification.service';
import { getChannels } from '../../providers/notifications/channels';
import { moneySurfaceCounter } from '../../plugins/observability';
import { AppError } from '../../utils/errors';
import { log } from '../../utils/logger';
import { ReviewDemoMoneyRefusedError, isReviewAccount } from '../review/demo-policy';

// ---------------------------------------------------------------------------
// [ALG-34 / ALG-INV-14] THE MONEY SURFACE — where a store's or a driver's money
// goes. A new MMG pay link is STAGED behind a cool-off with the old link still
// live and the owner told; the owner can cancel from any of their devices,
// which signs every other device out; only an unchallenged cool-off applies it.
//
// [R048-007] EVERY TRANSITION IS ONE ATOMIC AUTHORITY RECORD. The entity
// change, the algorithm decision, the old/new evidence digests, the step-up
// binding, the revocation consequence and the owner-notice INTENT are written
// in ONE transaction — under a per-entity advisory lock — or none of them
// are. A `MoneySurfaceCommand` row is that record: a per-entity audit
// generation that can only ever grow by one per committed transition. The
// notice is delivered AFTER commit from the committed intent and retried by
// the cool-off job until sent: exactly one intent per transition, never a
// notification about a change that did not commit, never a committed change
// nobody is told about. The executor applies only DECIDED commands it has
// leased. A step-up, when the deps carry Redis, is re-verified inside the
// transition: an unavailable control on a money surface is a refusal, never
// a pass.
// ---------------------------------------------------------------------------

export type LinkActor = 'VENDOR' | 'DRIVER';
export type LinkSignal = 'NEW_DEVICE' | 'NEW_IP';
export const ALGO_ID = 'ALG-34';
export const DEFAULT_LINK_COOLOFF_HOURS = 24;
/**
 * [owner 30 Oct 2026 via COORD · "do what's best for MMG"] A store's FIRST-EVER MMG number goes live after this
 * many hours instead of the configured cool-off. First ever = the very first number stage on record: no live
 * number, none pending, and NO earlier number command of any kind (a stage in any state — waiting, live,
 * replaced, cancelled or removed — an application, a removal or a cancel). A change, a number added again after
 * one was removed, or one staged again after a cancel or a removal keeps the full cool-off: a removal or a cancel
 * can never turn a full hold into the short one (whoever does either holds the owner's signed-in session). The ruling names the number only: an MMG pay link (store or
 * driver) keeps the full cool-off even the first time. Everything else (step-up, signals, decision, command,
 * owner notice, one-tap cancel) is exactly as for a change.
 */
export const FIRST_DESTINATION_HOLD_HOURS = 1;
/** How long an executor's lease on a due command lasts before another executor may take it. */
export const APPLY_LEASE_MS = 60_000;

export interface MoneySurfaceDeps {
  prisma: PrismaClient;
  io: Server;
  /** When present, the step-up is re-verified inside the staging transition (default-deny). */
  redis?: Redis;
  /** Test seam: a throw here is the process dying at that boundary. */
  failpoint?: (boundary: string) => Promise<void>;
}

export type CommandKind =
  | 'MMG_LINK_STAGE' | 'MMG_LINK_CANCEL' | 'MMG_LINK_CLEAR' | 'MMG_LINK_APPLY'
  | 'MMG_NUMBER_STAGE' | 'MMG_NUMBER_CANCEL' | 'MMG_NUMBER_CLEAR' | 'MMG_NUMBER_APPLY';
export type CommandState = 'DECIDED' | 'APPLIED' | 'CANCELLED' | 'SUPERSEDED';

/**
 * [owner 17 Oct 2026 · PAYMENT-SIMPLIFY · ALG-34 parity] The money surface has
 * TWO destinations, governed by ONE set of transitions: the MMG pay LINK (stores
 * and drivers; dormant behind its switches) and the store's MMG NUMBER (stores
 * only). Each field has its own live/pending/cool-off columns and its own command
 * kinds; the entity lock, the audit generation, the step-up re-check, the owner
 * notice outbox and the executor are shared, so the number gets every protection
 * the link has and no transition forks. Every caller that names no field means LINK.
 */
export type MoneySurfaceField = 'LINK' | 'NUMBER';

interface FieldSpec {
  live: 'mmgPayUrl' | 'mmgNumber';
  pending: 'mmgPayUrlPending' | 'mmgNumberPending';
  pendingAt: 'mmgPayUrlPendingAt' | 'mmgNumberPendingAt';
  applyAt: 'mmgPayUrlApplyAt' | 'mmgNumberApplyAt';
  stage: CommandKind; cancel: CommandKind; clear: CommandKind; apply: CommandKind;
  /** How the owner reads it: "MMG pay link" / "MMG number". */
  noun: string;
  /** Notice kind prefix and dedupe-key prefix. */
  key: 'mmg_link' | 'mmg_number';
  dedupe: 'mmg-link' | 'mmg-number';
}

const FIELDS: Record<MoneySurfaceField, FieldSpec> = {
  LINK: {
    live: 'mmgPayUrl', pending: 'mmgPayUrlPending', pendingAt: 'mmgPayUrlPendingAt', applyAt: 'mmgPayUrlApplyAt',
    stage: 'MMG_LINK_STAGE', cancel: 'MMG_LINK_CANCEL', clear: 'MMG_LINK_CLEAR', apply: 'MMG_LINK_APPLY',
    noun: 'MMG pay link', key: 'mmg_link', dedupe: 'mmg-link',
  },
  NUMBER: {
    live: 'mmgNumber', pending: 'mmgNumberPending', pendingAt: 'mmgNumberPendingAt', applyAt: 'mmgNumberApplyAt',
    stage: 'MMG_NUMBER_STAGE', cancel: 'MMG_NUMBER_CANCEL', clear: 'MMG_NUMBER_CLEAR', apply: 'MMG_NUMBER_APPLY',
    noun: 'MMG number', key: 'mmg_number', dedupe: 'mmg-number',
  },
};

const clearPending = (spec: FieldSpec): Record<string, null> => ({ [spec.pending]: null, [spec.pendingAt]: null, [spec.applyAt]: null });

export const digestOf = (value: string | null | undefined): string => (value ? createHash('sha256').update(value).digest('hex') : 'none');
/** The step-up binding: which session's step-up authorised which change to which surface. A binding, not a secret. */
export const stepUpBindingOf = (sessionId: string | null, entityId: string, newDigest: string): string | null =>
  sessionId ? createHash('sha256').update(`${sessionId}:${entityId}:${newDigest}`).digest('hex') : null;

export function whenSentence(at: Date): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'America/Guyana', weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true,
  }).format(at);
}

const hostOf = (url: string): string => { try { return new URL(url).host; } catch { return 'invalid'; } };

/** The signals a staging session shows: a device or an IP never seen on this account before. */
export async function sessionSignals(
  prisma: PrismaClient,
  userId: string,
  sessionId: string | null,
): Promise<{ signals: LinkSignal[]; sessionAgeMin: number | null; deviceId: string | null }> {
  if (!sessionId) return { signals: [], sessionAgeMin: null, deviceId: null };
  const s = await prisma.session.findUnique({ where: { id: sessionId }, select: { deviceId: true, ipAddress: true, createdAt: true } });
  if (!s) return { signals: [], sessionAgeMin: null, deviceId: null };
  const [sameDevice, sameIp] = await Promise.all([
    prisma.session.count({ where: { userId, deviceId: s.deviceId, id: { not: sessionId }, createdAt: { lt: s.createdAt } } }),
    s.ipAddress
      ? prisma.session.count({ where: { userId, ipAddress: s.ipAddress, id: { not: sessionId }, createdAt: { lt: s.createdAt } } })
      : Promise.resolve(-1),
  ]);
  const signals: LinkSignal[] = [];
  if (sameDevice === 0) signals.push('NEW_DEVICE');
  if (sameIp === 0) signals.push('NEW_IP');
  return { signals, sessionAgeMin: Math.max(0, Math.round((Date.now() - s.createdAt.getTime()) / 60_000)), deviceId: s.deviceId };
}

function fromClause(signals: LinkSignal[]): string {
  const parts: string[] = [];
  if (signals.includes('NEW_DEVICE')) parts.push('a device never seen on this account');
  if (signals.includes('NEW_IP')) parts.push('an IP never seen on this account');
  return parts.length ? `from ${parts.join(' and ')}` : 'from a known device';
}

interface OwnerNotice {
  title: string;
  body: string;
  kind: string;
  sms?: string;
  dedupeKey?: string;
}

type Tx = Prisma.TransactionClient;

// ---------------------------------------------------------------------------
// The one authority record
// ---------------------------------------------------------------------------

async function lockEntity(tx: Tx, entityId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`money-surface:${entityId}`}))`;
}

async function nextGeneration(tx: Tx, entityId: string): Promise<number> {
  const last = await tx.moneySurfaceCommand.findFirst({ where: { entityId }, orderBy: { generation: 'desc' }, select: { generation: true } });
  return (last?.generation ?? 0) + 1;
}

/** Does this store or driver belong to the store-review fiction? */
async function entityIsFiction(prisma: PrismaClient, actor: LinkActor, entityId: string): Promise<boolean> {
  const kind = actor === 'VENDOR'
    ? (await prisma.vendor.findUnique({ where: { id: entityId }, select: { tenant: { select: { kind: true } } } }))?.tenant.kind
    : (await prisma.driver.findUnique({ where: { id: entityId }, select: { user: { select: { tenant: { select: { kind: true } } } } } }))?.user.tenant.kind;
  return kind === 'REVIEW';
}

/** The one field's authority, read under the entity lock: the live destination, the staged one and when it applies. */
type LinkState = { live: string | null; pending: string | null; applyAt: Date | null; userId: string; fiction: boolean };

/**
 * The authority read every transition makes first, under the entity lock.
 * [REVIEW-PARTNER · DL-5] It also says whether the entity belongs to the
 * store-review fiction (a REVIEW tenant), which has no money rail: stage,
 * cancel and clear REFUSE it here — before any write, decision, command or
 * owner notice (whose SMS would reach a fictional number) — and the executor
 * skips it. One check, at the one place every MMG-link change passes.
 */
async function readLink(tx: Tx, actor: LinkActor, entityId: string, onFiction: 'refuse' | 'report' = 'refuse', field: MoneySurfaceField = 'LINK'): Promise<LinkState> {
  let state: LinkState;
  if (actor === 'VENDOR') {
    const v = await tx.vendor.findUnique({
      where: { id: entityId },
      select: {
        mmgPayUrl: true, mmgPayUrlPending: true, mmgPayUrlApplyAt: true,
        mmgNumber: true, mmgNumberPending: true, mmgNumberApplyAt: true,
        tenant: { select: { kind: true } }, owner: { select: { userId: true } },
      },
    });
    if (!v) throw new AppError(404, 'NOT_FOUND', 'Store not found');
    state = field === 'NUMBER'
      ? { live: v.mmgNumber, pending: v.mmgNumberPending, applyAt: v.mmgNumberApplyAt, userId: v.owner.userId, fiction: v.tenant.kind === 'REVIEW' }
      : { live: v.mmgPayUrl, pending: v.mmgPayUrlPending, applyAt: v.mmgPayUrlApplyAt, userId: v.owner.userId, fiction: v.tenant.kind === 'REVIEW' };
  } else {
    // A driver has a pay link only: there is no driver MMG number.
    if (field !== 'LINK') throw new AppError(400, 'NOT_SUPPORTED', 'Only a store has an MMG number on Swift.');
    const d = await tx.driver.findUnique({ where: { id: entityId }, select: { mmgPayUrl: true, mmgPayUrlPending: true, mmgPayUrlApplyAt: true, userId: true, user: { select: { tenant: { select: { kind: true } } } } } });
    if (!d) throw new AppError(404, 'NOT_FOUND', 'Driver not found');
    state = { live: d.mmgPayUrl, pending: d.mmgPayUrlPending, applyAt: d.mmgPayUrlApplyAt, userId: d.userId, fiction: d.user.tenant.kind === 'REVIEW' };
  }
  if (state.fiction && onFiction === 'refuse') {
    moneySurfaceCounter.labels('refused_review_fiction').inc();
    throw new ReviewDemoMoneyRefusedError();
  }
  return state;
}

/** A compare-and-set write on the entity: the authority moves only from the state this transition read. */
async function writeLink(
  tx: Tx, actor: LinkActor, entityId: string, spec: FieldSpec,
  expect: { live: string | null },
  data: Record<string, unknown>,
): Promise<void> {
  const where = { id: entityId, [spec.live]: expect.live };
  const r = actor === 'VENDOR'
    ? await tx.vendor.updateMany({ where: where as Prisma.VendorWhereInput, data })
    : await tx.driver.updateMany({ where: where as Prisma.DriverWhereInput, data });
  if (r.count !== 1) {
    moneySurfaceCounter.labels('refused_authority_moved').inc();
    throw new AppError(409, 'AUTHORITY_MOVED', spec.key === 'mmg_link' ? 'The pay link changed under this request; read it again.' : `The ${spec.noun} changed under this request; read it again.`);
  }
}

/** The decision row is part of the record: a transition without one does not commit. */
async function decide(tx: Tx, d: Parameters<typeof recordDecision>[1]): Promise<string> {
  const id = await recordDecision(tx, d);
  if (!id) {
    moneySurfaceCounter.labels('refused_no_decision').inc();
    throw new AppError(500, 'DECISION_NOT_RECORDED', 'The authorisation decision could not be recorded; nothing was changed.');
  }
  return id;
}

async function supersedeOpenStage(tx: Tx, entityId: string, spec: FieldSpec = FIELDS.LINK): Promise<void> {
  await tx.moneySurfaceCommand.updateMany({ where: { entityId, kind: spec.stage, state: 'DECIDED' }, data: { state: 'SUPERSEDED' } });
}

/** Has this field any command on record for this entity — a stage in any state, an application, a removal or a
 *  cancel? Any of them means this is not the first number: a removal of a waiting value (even one staged before
 *  the command history existed) and a cancel both leave their command, so neither can reset the hold. */
async function hasFieldHistory(db: Tx | PrismaClient, entityId: string, spec: FieldSpec): Promise<boolean> {
  const seen = await db.moneySurfaceCommand.findFirst({
    where: { entityId, kind: { in: [spec.stage, spec.apply, spec.clear, spec.cancel] } },
    select: { id: true },
  });
  return seen != null;
}

/** How long a value staged now would wait: the short first-number hold (MMG number only), or the configured cool-off. */
async function holdFor(
  db: Tx | PrismaClient, entityId: string, spec: FieldSpec, current: { live: string | null; pending: string | null }, cooloffHours: number,
): Promise<{ hours: number; first: boolean }> {
  const first = spec.key === 'mmg_number' && current.live == null && current.pending == null && !(await hasFieldHistory(db, entityId, spec));
  return { hours: first ? Math.min(FIRST_DESTINATION_HOLD_HOURS, cooloffHours) : cooloffHours, first };
}

async function configuredCooloff(prisma: PrismaClient): Promise<{ hours: number; version: number }> {
  const cfg = await algoConfig(prisma, 'money.linkCooloffHours');
  return { hours: Math.min(72, Math.max(1, Number(cfg.value) || DEFAULT_LINK_COOLOFF_HOURS)), version: cfg.version };
}

/** [owner 30 Oct 2026] What the owner's screen says before they save: how many hours a value set NOW would wait
 *  (the same rule stageMmgLinkChange applies). Read-only; null when the entity is not found. */
export async function nextMoneySurfaceHoldHours(prisma: PrismaClient, actor: LinkActor, entityId: string, field: MoneySurfaceField = 'LINK'): Promise<number | null> {
  const spec = FIELDS[field];
  const row = actor === 'VENDOR'
    ? await prisma.vendor.findUnique({ where: { id: entityId }, select: { [spec.live]: true, [spec.pending]: true } as Prisma.VendorSelect })
    : await prisma.driver.findUnique({ where: { id: entityId }, select: { mmgPayUrl: true, mmgPayUrlPending: true } });
  if (!row) return null;
  const values = row as Record<string, string | null>;
  const { hours } = await configuredCooloff(prisma);
  return (await holdFor(prisma, entityId, spec, { live: values[spec.live] ?? null, pending: values[spec.pending] ?? null }, hours)).hours;
}

interface CommandDraft {
  actor: LinkActor; entityId: string; userId: string; kind: CommandKind; state: CommandState;
  oldDigest: string; newDigest: string; decisionId: string; stepUpSessionId?: string | null; signals?: LinkSignal[];
  applyAt?: Date | null; notice?: OwnerNotice | null;
}

async function writeCommand(tx: Tx, generation: number, draft: CommandDraft) {
  return tx.moneySurfaceCommand.create({
    data: {
      actor: draft.actor, entityId: draft.entityId, userId: draft.userId, kind: draft.kind, state: draft.state, generation,
      oldDigest: draft.oldDigest, newDigest: draft.newDigest, decisionId: draft.decisionId,
      stepUpSessionId: draft.stepUpSessionId ?? null,
      stepUpBinding: stepUpBindingOf(draft.stepUpSessionId ?? null, draft.entityId, draft.newDigest),
      signals: (draft.signals ?? []) as unknown as Prisma.InputJsonValue,
      applyAt: draft.applyAt ?? null,
      noticeKind: draft.notice?.kind ?? null,
      noticeDedupeKey: draft.notice?.dedupeKey ?? null,
      noticePayload: draft.notice ? ({ title: draft.notice.title, body: draft.notice.body, ...(draft.notice.sms ? { sms: draft.notice.sms } : {}) } as Prisma.InputJsonValue) : undefined,
    },
  });
}

// ---------------------------------------------------------------------------
// The notice outbox: delivered from the committed intent, retried until sent
// ---------------------------------------------------------------------------

type CommandRow = Prisma.MoneySurfaceCommandGetPayload<Record<string, never>>;

export async function deliverCommandNotice(deps: MoneySurfaceDeps, cmd: CommandRow): Promise<boolean> {
  if (!cmd.noticeKind || cmd.noticeSentAt) return false;
  // [REVIEW-PARTNER · DL-5] A command owned by the store-review fiction is never delivered — no
  // notification, no SMS — including one committed before the fiction was sealed. It is retired
  // from the retry sweep (attempts at the sweep's bound) with the reason, and never marked sent.
  if (await isReviewAccount(deps.prisma, cmd.userId)) {
    await deps.prisma.moneySurfaceCommand.update({ where: { id: cmd.id }, data: { noticeAttempts: NOTICE_MAX_ATTEMPTS, noticeLastError: 'review-tenant send suppressed' } }).catch(() => undefined);
    moneySurfaceCounter.labels('notice_review_suppressed').inc();
    log().info({ commandId: cmd.id }, 'review-tenant send suppressed: money-surface notice');
    return false;
  }
  const payload = (cmd.noticePayload ?? {}) as { title?: string; body?: string; sms?: string };
  try {
    const id = await new NotificationService(deps.prisma, deps.io).send({
      userId: cmd.userId,
      type: 'SYSTEM_ANNOUNCEMENT',
      title: payload.title ?? '',
      body: payload.body ?? '',
      data: { kind: cmd.noticeKind, actor: cmd.actor, commandId: cmd.id },
      ...(cmd.noticeDedupeKey ? { dedupeKey: cmd.noticeDedupeKey } : {}),
    });
    if (!id) throw new Error('notification service returned no id');
    if (payload.sms) {
      const user = await deps.prisma.user.findUnique({ where: { id: cmd.userId }, select: { phone: true } });
      if (user?.phone) await getChannels().sms.sendSms(user.phone, payload.sms);
    }
    await deps.prisma.moneySurfaceCommand.update({ where: { id: cmd.id }, data: { noticeSentAt: new Date(), noticeAttempts: { increment: 1 }, noticeLastError: null } });
    moneySurfaceCounter.labels('notice_sent').inc();
    return true;
  } catch (err) {
    await deps.prisma.moneySurfaceCommand.update({ where: { id: cmd.id }, data: { noticeAttempts: { increment: 1 }, noticeLastError: err instanceof Error ? err.message.slice(0, 500) : String(err) } }).catch(() => undefined);
    moneySurfaceCounter.labels('notice_retry').inc();
    log().warn({ err, commandId: cmd.id }, 'money-surface: owner notice not delivered — the cool-off job retries it');
    return false;
  }
}

/** The sweep's retry bound: a notice that has failed this often is no longer retried. */
const NOTICE_MAX_ATTEMPTS = 20;

/** The retry sweep, run by the cool-off job: every committed intent not yet sent. */
export async function deliverPendingMoneySurfaceNotices(deps: MoneySurfaceDeps, now = new Date()): Promise<{ delivered: number; pending: number }> {
  const rows = await deps.prisma.moneySurfaceCommand.findMany({
    where: { noticeKind: { not: null }, noticeSentAt: null, createdAt: { lt: new Date(now.getTime() - 15_000) }, noticeAttempts: { lt: NOTICE_MAX_ATTEMPTS } },
    orderBy: { createdAt: 'asc' },
    take: 100,
  });
  let delivered = 0;
  for (const cmd of rows) if (await deliverCommandNotice(deps, cmd)) delivered += 1;
  moneySurfaceCounter.labels('notice_sweep').inc();
  return { delivered, pending: rows.length - delivered };
}

// ---------------------------------------------------------------------------
// The transitions
// ---------------------------------------------------------------------------

export interface StageInput {
  actor: LinkActor;
  entityId: string;
  /** The account that owns the surface — the OLD contact point is theirs. */
  userId: string;
  sessionId: string | null;
  /** LINK (default): the new pay link, already validated by utils/mmg-pay-url. */
  newUrl?: string;
  /** NUMBER: the store's new MMG number, already validated by utils/mmg-number. */
  newNumber?: string;
  field?: MoneySurfaceField;
  now?: Date;
}

/** What the owner is told, per field: the same three moments, in the field's own words. */
function stagedNotice(spec: FieldSpec, actor: LinkActor, entityId: string, applyAt: Date, hasLive: boolean): OwnerNotice {
  if (spec.key === 'mmg_number') {
    return {
      title: 'Your MMG number is changing',
      // [owner 30 Oct 2026] With no live number there is no "current number" to keep paying: say what is true.
      body: hasLive
        ? `The new number takes effect ${whenSentence(applyAt)}. Until then customers pay your current number. If this wasn’t you, open Account and cancel it now — that also signs out every other device.`
        : `Your MMG number takes effect ${whenSentence(applyAt)}. Until then customers cannot choose MMG for your store. If this wasn’t you, open Account and cancel it now — that also signs out every other device.`,
      kind: 'mmg_number_change_staged',
      sms: `Swift: the MMG number on your store account changes ${whenSentence(applyAt)}. If this wasn't you, open Swift > Account and cancel it now.`,
      dedupeKey: `mmg-number-staged:${entityId}:${applyAt.toISOString()}`,
    };
  }
  return {
    title: 'Your MMG pay link is changing',
    body: `The new link takes effect ${whenSentence(applyAt)}. If this wasn’t you, open Account and cancel it now — that also signs out every other device.`,
    kind: 'mmg_link_change_staged',
    sms: `Swift: the MMG pay link on your ${actor === 'VENDOR' ? 'store' : 'driver'} account changes ${whenSentence(applyAt)}. If this wasn't you, open Swift > Account and cancel it now.`,
    dedupeKey: `mmg-link-staged:${entityId}:${applyAt.toISOString()}`,
  };
}

export async function stageMmgLinkChange(deps: MoneySurfaceDeps, input: StageInput): Promise<{ applyAt: Date; cooloffHours: number; signals: LinkSignal[]; commandId: string; replay: boolean }> {
  const now = input.now ?? new Date();
  const spec = FIELDS[input.field ?? 'LINK'];
  const newValue = spec.key === 'mmg_number' ? input.newNumber : input.newUrl;
  if (!newValue) throw new AppError(400, 'VALIDATION_ERROR', `No new ${spec.noun} was given.`);
  // [R048-007] default-deny: when the control is reachable it is re-verified here; when it is not, the money surface refuses
  if (deps.redis) {
    let ok = false;
    try { ok = !!input.sessionId && (await hasStepUp(deps.redis, input.sessionId)); } catch { moneySurfaceCounter.labels('refused_control_unavailable').inc(); throw new AppError(503, 'CONTROL_UNAVAILABLE', spec.key === 'mmg_link' ? 'The step-up check is unavailable right now; the pay link was not changed.' : `The step-up check is unavailable right now; the ${spec.noun} was not changed.`); }
    if (!ok) { moneySurfaceCounter.labels('refused_step_up').inc(); throw new AppError(403, 'STEP_UP_REQUIRED', 'Confirm it’s you first — we’ll text a code to the phone on this account.'); }
  }
  const cfg = await configuredCooloff(deps.prisma);
  const cooloffHours = cfg.hours;
  const sig = await sessionSignals(deps.prisma, input.userId, input.sessionId);
  const newDigest = digestOf(newValue);
  const result = await deps.prisma.$transaction(async (tx) => {
    await lockEntity(tx, input.entityId);
    const current = await readLink(tx, input.actor, input.entityId, 'refuse', input.field ?? 'LINK');
    await deps.failpoint?.('tx:after-read');
    const open = await tx.moneySurfaceCommand.findFirst({ where: { entityId: input.entityId, kind: spec.stage, state: 'DECIDED' } });
    // replay convergence: the same change staged again is the same command, not a second one
    if (open && open.newDigest === newDigest && open.applyAt) {
      moneySurfaceCounter.labels('stage_replay').inc();
      return { command: open, replay: true, applyAt: open.applyAt, holdHours: Math.max(1, Math.round((open.applyAt.getTime() - open.createdAt.getTime()) / 3_600_000)) };
    }
    // Read under the entity lock, before this stage supersedes anything: the pending value is still on the row.
    const hold = await holdFor(tx, input.entityId, spec, current, cooloffHours);
    const applyAt = new Date(now.getTime() + hold.hours * 3_600_000);
    const notice = stagedNotice(spec, input.actor, input.entityId, applyAt, current.live != null);
    if (open) await supersedeOpenStage(tx, input.entityId, spec);
    const generation = await nextGeneration(tx, input.entityId);
    await writeLink(tx, input.actor, input.entityId, spec, { live: current.live }, { [spec.pending]: newValue, [spec.pendingAt]: now, [spec.applyAt]: applyAt });
    await deps.failpoint?.('tx:after-entity');
    const decisionId = await decide(tx, {
      algo: ALGO_ID, subjectType: input.actor, subjectId: input.entityId, outcome: 'STAGED',
      sentence: spec.key === 'mmg_number'
        ? (current.live != null
          ? `MMG number change staged ${fromClause(sig.signals)}; the old number stays live until ${whenSentence(applyAt)} unless the owner cancels.`
          : `MMG number staged ${fromClause(sig.signals)}${hold.first ? ' (the store\u2019s first)' : ''}; no number is live until ${whenSentence(applyAt)}, and it goes live then unless the owner cancels.`)
        : (current.live != null
          ? `MMG pay link change staged ${fromClause(sig.signals)}; the old link stays live until ${whenSentence(applyAt)} unless the owner cancels.`
          : `MMG pay link staged ${fromClause(sig.signals)}; no link is live until ${whenSentence(applyAt)}, and it goes live then unless the owner cancels.`),
      // The number itself never enters the decision record: its digest is on the command.
      inputs: spec.key === 'mmg_number'
        ? { field: 'NUMBER', signals: sig.signals, sessionAgeMin: sig.sessionAgeMin, deviceId: sig.deviceId, hadNumber: current.live != null, firstDestination: hold.first, holdHours: hold.hours, cooloffHours, applyAt: applyAt.toISOString(), generation }
        : {
            signals: sig.signals, sessionAgeMin: sig.sessionAgeMin, deviceId: sig.deviceId,
            hadLink: current.live != null, firstDestination: hold.first, holdHours: hold.hours, newHost: hostOf(newValue), cooloffHours, applyAt: applyAt.toISOString(), generation,
          },
      configVersion: cfg.version,
    });
    await deps.failpoint?.('tx:after-decision');
    const command = await writeCommand(tx, generation, {
      actor: input.actor, entityId: input.entityId, userId: input.userId, kind: spec.stage, state: 'DECIDED',
      oldDigest: digestOf(current.live), newDigest, decisionId, stepUpSessionId: input.sessionId, signals: sig.signals, applyAt, notice,
    });
    await deps.failpoint?.('tx:after-command');
    return { command, replay: false, applyAt, holdHours: hold.hours };
  });
  moneySurfaceCounter.labels(result.replay ? 'stage_replay' : 'staged').inc();
  await deps.failpoint?.('after-commit');
  if (!result.replay) await deliverCommandNotice(deps, result.command);
  // cooloffHours is the hold THIS stage got: the first-destination hour or the configured cool-off.
  return { applyAt: result.applyAt, cooloffHours: result.holdHours, signals: sig.signals, commandId: result.command.id, replay: result.replay };
}

export async function cancelMmgLinkChange(
  deps: MoneySurfaceDeps,
  input: { actor: LinkActor; entityId: string; userId: string; keepSessionId: string | null; field?: MoneySurfaceField },
): Promise<{ cancelled: boolean; revokedSessions: number }> {
  const spec = FIELDS[input.field ?? 'LINK'];
  const result = await deps.prisma.$transaction(async (tx) => {
    await lockEntity(tx, input.entityId);
    const current = await readLink(tx, input.actor, input.entityId, 'refuse', input.field ?? 'LINK');
    await deps.failpoint?.('tx:after-read');
    if (current.pending == null) return null;
    const generation = await nextGeneration(tx, input.entityId);
    await writeLink(tx, input.actor, input.entityId, spec, { live: current.live }, clearPending(spec));
    await deps.failpoint?.('tx:after-entity');
    // the revocation consequence is part of the same authority transition
    const revoked = await tx.session.deleteMany({
      where: { userId: input.userId, ...(input.keepSessionId ? { id: { not: input.keepSessionId } } : {}) },
    });
    await supersedeOpenStage(tx, input.entityId, spec);
    await tx.moneySurfaceCommand.updateMany({ where: { entityId: input.entityId, kind: spec.stage, state: 'SUPERSEDED', newDigest: digestOf(current.pending) }, data: { state: 'CANCELLED' } });
    const decisionId = await decide(tx, {
      algo: ALGO_ID, subjectType: input.actor, subjectId: input.entityId, outcome: 'CANCELLED_BY_OWNER',
      sentence: `The owner cancelled the pending ${spec.noun} change and ${revoked.count} other session${revoked.count === 1 ? ' was' : 's were'} signed out.`,
      inputs: spec.key === 'mmg_number' ? { field: 'NUMBER', revokedSessions: revoked.count, generation } : { revokedSessions: revoked.count, generation },
    });
    await deps.failpoint?.('tx:after-decision');
    const command = await writeCommand(tx, generation, {
      actor: input.actor, entityId: input.entityId, userId: input.userId, kind: spec.cancel, state: 'APPLIED',
      oldDigest: digestOf(current.pending), newDigest: digestOf(current.live), decisionId, stepUpSessionId: input.keepSessionId,
      notice: spec.key === 'mmg_number'
        ? {
            title: 'MMG number change cancelled',
            body: `The pending change was cancelled and ${revoked.count} other device${revoked.count === 1 ? ' was' : 's were'} signed out. Your current number stays as it was.`,
            kind: 'mmg_number_change_cancelled',
          }
        : {
            title: 'MMG pay link change cancelled',
            body: `The pending change was cancelled and ${revoked.count} other device${revoked.count === 1 ? ' was' : 's were'} signed out. Your current link stays as it was.`,
            kind: 'mmg_link_change_cancelled',
          },
    });
    await deps.failpoint?.('tx:after-command');
    return { command, revoked: revoked.count };
  });
  if (!result) return { cancelled: false, revokedSessions: 0 };
  moneySurfaceCounter.labels('cancelled').inc();
  await deps.failpoint?.('after-commit');
  await deliverCommandNotice(deps, result.command);
  return { cancelled: true, revokedSessions: result.revoked };
}

export async function clearMmgLink(deps: MoneySurfaceDeps, input: { actor: LinkActor; entityId: string; userId?: string; field?: MoneySurfaceField }): Promise<void> {
  const spec = FIELDS[input.field ?? 'LINK'];
  const cleared = await deps.prisma.$transaction(async (tx) => {
    await lockEntity(tx, input.entityId);
    const current = await readLink(tx, input.actor, input.entityId, 'refuse', input.field ?? 'LINK');
    await deps.failpoint?.('tx:after-read');
    const generation = await nextGeneration(tx, input.entityId);
    await writeLink(tx, input.actor, input.entityId, spec, { live: current.live }, { [spec.live]: null, ...clearPending(spec) });
    await deps.failpoint?.('tx:after-entity');
    await supersedeOpenStage(tx, input.entityId, spec);
    const decisionId = await decide(tx, {
      algo: ALGO_ID, subjectType: input.actor, subjectId: input.entityId, outcome: 'CLEARED',
      sentence: spec.key === 'mmg_number'
        ? 'The MMG number was removed; customers cannot choose MMG for this store until a new number clears its cool-off.'
        : 'The MMG pay link was removed; the account is cash-only until a new link clears its cool-off.',
      inputs: spec.key === 'mmg_number' ? { field: 'NUMBER', generation } : { generation },
    });
    await deps.failpoint?.('tx:after-decision');
    // [first-number rule hardened · 30 Oct 2026] Removing a number that was WAITING to go live tells the owner (app +
    // text), from the same outbox as every other money-surface notice: a removal they did not make is seen.
    const notice: OwnerNotice | null = spec.key === 'mmg_number' && current.pending != null
      ? {
          title: 'Your new MMG number was removed',
          body: 'The MMG number that was waiting to go live was removed, so it will not go live. Customers cannot choose MMG for your store until a new number clears its hold. If this wasn’t you, contact Swift support right away.',
          kind: 'mmg_number_pending_removed',
          sms: "Swift: the MMG number waiting to go live on your store account was removed. If this wasn't you, contact Swift support right away.",
          dedupeKey: `mmg-number-pending-removed:${input.entityId}:${generation}`,
        }
      : null;
    const command = await writeCommand(tx, generation, {
      actor: input.actor, entityId: input.entityId, userId: input.userId ?? current.userId, kind: spec.clear, state: 'APPLIED',
      oldDigest: digestOf(current.live), newDigest: 'none', decisionId, notice,
    });
    await deps.failpoint?.('tx:after-command');
    return command;
  });
  moneySurfaceCounter.labels('cleared').inc();
  await deliverCommandNotice(deps, cleared);
}

/**
 * The executor: applies only DECIDED stage commands it has LEASED, each in
 * its own transaction under the entity lock. A staged row with no command —
 * staged before this record existed — is applied the same way and given its
 * command at application, so the audit generation still counts it.
 */
export async function applyDueMmgLinkChanges(deps: MoneySurfaceDeps, now = new Date()): Promise<{ applied: number }> {
  let applied = 0;
  const due: Array<{ actor: LinkActor; id: string; field: MoneySurfaceField }> = [];
  const vendors = await deps.prisma.vendor.findMany({ where: { mmgPayUrlApplyAt: { lte: now }, mmgPayUrlPending: { not: null } }, select: { id: true }, take: 200 });
  const drivers = await deps.prisma.driver.findMany({ where: { mmgPayUrlApplyAt: { lte: now }, mmgPayUrlPending: { not: null } }, select: { id: true }, take: 200 });
  // [PAYMENT-SIMPLIFY] A store's staged MMG NUMBER goes live by the same executor, lease and record.
  const numbers = await deps.prisma.vendor.findMany({ where: { mmgNumberApplyAt: { lte: now }, mmgNumberPending: { not: null } }, select: { id: true }, take: 200 });
  due.push(
    ...vendors.map((v) => ({ actor: 'VENDOR' as const, id: v.id, field: 'LINK' as const })),
    ...drivers.map((d) => ({ actor: 'DRIVER' as const, id: d.id, field: 'LINK' as const })),
    ...numbers.map((v) => ({ actor: 'VENDOR' as const, id: v.id, field: 'NUMBER' as const })),
  );
  for (const item of due) {
    const spec = FIELDS[item.field];
    // [REVIEW-PARTNER · DL-5] The fiction's links never go live: skipped before ANY write (no lease).
    if (await entityIsFiction(deps.prisma, item.actor, item.id)) { moneySurfaceCounter.labels('apply_review_skipped').inc(); continue; }
    // lease the command (when there is one) so two executors never apply the same change
    const open = await deps.prisma.moneySurfaceCommand.findFirst({ where: { entityId: item.id, kind: spec.stage, state: 'DECIDED' } });
    if (open) {
      const leased = await deps.prisma.moneySurfaceCommand.updateMany({
        where: { id: open.id, state: 'DECIDED', OR: [{ leasedUntil: null }, { leasedUntil: { lt: now } }] },
        data: { leasedUntil: new Date(now.getTime() + APPLY_LEASE_MS) },
      });
      if (leased.count !== 1) { moneySurfaceCounter.labels('apply_lease_missed').inc(); continue; }
    }
    const done = await deps.prisma.$transaction(async (tx) => {
      await lockEntity(tx, item.id);
      const current = await readLink(tx, item.actor, item.id, 'report', item.field);
      await deps.failpoint?.('tx:after-read');
      if (current.fiction) return false; // [REVIEW-PARTNER] the fiction's links never go live (and are never staged)
      if (!current.pending || !current.applyAt || current.applyAt > now) return false;
      const stage = await tx.moneySurfaceCommand.findFirst({ where: { entityId: item.id, kind: spec.stage, state: 'DECIDED' } });
      if (open && (!stage || stage.id !== open.id)) return false; // moved under us: cancelled or superseded
      const generation = await nextGeneration(tx, item.id);
      await writeLink(tx, item.actor, item.id, spec, { live: current.live }, { [spec.live]: current.pending, ...clearPending(spec) });
      await deps.failpoint?.('tx:after-entity');
      if (stage) await tx.moneySurfaceCommand.update({ where: { id: stage.id }, data: { state: 'APPLIED', appliedAt: now, leasedUntil: null } });
      const decisionId = await decide(tx, {
        algo: ALGO_ID, subjectType: item.actor, subjectId: item.id, outcome: 'APPLIED',
        sentence: `The staged ${spec.noun} went live after its cool-off passed without a cancellation.`,
        inputs: item.field === 'NUMBER'
          ? { field: 'NUMBER', applyAt: current.applyAt.toISOString(), generation, legacy: !stage }
          : { applyAt: current.applyAt.toISOString(), newHost: hostOf(current.pending), generation, legacy: !stage },
      });
      await deps.failpoint?.('tx:after-decision');
      const command = await writeCommand(tx, generation, {
        actor: item.actor, entityId: item.id, userId: current.userId, kind: spec.apply, state: 'APPLIED',
        oldDigest: digestOf(current.live), newDigest: digestOf(current.pending), decisionId, stepUpSessionId: stage?.stepUpSessionId ?? null,
        notice: item.field === 'NUMBER'
          ? {
              title: 'Your new MMG number is live',
              body: 'Customers paying by MMG now pay to the number you set.',
              kind: 'mmg_number_change_applied',
              dedupeKey: `mmg-number-applied:${item.id}:${current.applyAt.toISOString()}`,
            }
          : {
              title: 'Your new MMG pay link is live',
              body: item.actor === 'VENDOR' ? 'Customers paying by MMG now pay to the link you set.' : 'Riders paying by MMG now pay to the link you set.',
              kind: 'mmg_link_change_applied',
              dedupeKey: `mmg-link-applied:${item.id}:${current.applyAt.toISOString()}`,
            },
      });
      await deps.failpoint?.('tx:after-command');
      return command;
    });
    if (!done) continue;
    applied += 1;
    moneySurfaceCounter.labels('applied').inc();
    await deps.failpoint?.('after-commit');
    await deliverCommandNotice(deps, done);
  }
  return { applied };
}

/** Read-only: the authority inventory the rollout census reads — open commands and live destinations. */
/** [#1848 follow-up · REVIEW-M S4] When an account closes, its payee details are cleared (VENDOR_MMG_DESTINATION_CLEARED);
 *  a link or number change staged before that would stay DECIDED forever — the executor never applies it once the
 *  field is gone — and keep counting as an open stage. It closes with the account, in the same commit. */
export async function closeOpenMmgStagesFor(
  tx: { moneySurfaceCommand: { updateMany(args: Prisma.MoneySurfaceCommandUpdateManyArgs): Promise<{ count: number }> } },
  entityIds: readonly string[],
): Promise<number> {
  if (entityIds.length === 0) return 0;
  const { count } = await tx.moneySurfaceCommand.updateMany({
    where: { entityId: { in: [...entityIds] }, kind: { in: [FIELDS.LINK.stage, FIELDS.NUMBER.stage] }, state: 'DECIDED' },
    data: { state: 'SUPERSEDED' },
  });
  return count;
}

export async function moneySurfaceInventory(prisma: PrismaClient): Promise<{ openStages: number; unsentNotices: number; appliedWithoutDecision: number }> {
  const [openStages, unsentNotices, appliedWithoutDecision] = await Promise.all([
    prisma.moneySurfaceCommand.count({ where: { kind: { in: ['MMG_LINK_STAGE', 'MMG_NUMBER_STAGE'] }, state: 'DECIDED' } }),
    prisma.moneySurfaceCommand.count({ where: { noticeKind: { not: null }, noticeSentAt: null } }),
    prisma.moneySurfaceCommand.count({ where: { state: 'APPLIED', decisionId: null } }),
  ]);
  return { openStages, unsentNotices, appliedWithoutDecision };
}
