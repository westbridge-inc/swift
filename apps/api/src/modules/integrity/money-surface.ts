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

export type CommandKind = 'MMG_LINK_STAGE' | 'MMG_LINK_CANCEL' | 'MMG_LINK_CLEAR' | 'MMG_LINK_APPLY';
export type CommandState = 'DECIDED' | 'APPLIED' | 'CANCELLED' | 'SUPERSEDED';

const CLEAR_PENDING = { mmgPayUrlPending: null, mmgPayUrlPendingAt: null, mmgPayUrlApplyAt: null } as const;

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

async function readLink(tx: Tx, actor: LinkActor, entityId: string): Promise<{ mmgPayUrl: string | null; mmgPayUrlPending: string | null; mmgPayUrlApplyAt: Date | null; userId: string }> {
  if (actor === 'VENDOR') {
    const v = await tx.vendor.findUnique({ where: { id: entityId }, select: { mmgPayUrl: true, mmgPayUrlPending: true, mmgPayUrlApplyAt: true, owner: { select: { userId: true } } } });
    if (!v) throw new AppError(404, 'NOT_FOUND', 'Store not found');
    return { mmgPayUrl: v.mmgPayUrl, mmgPayUrlPending: v.mmgPayUrlPending, mmgPayUrlApplyAt: v.mmgPayUrlApplyAt, userId: v.owner.userId };
  }
  const d = await tx.driver.findUnique({ where: { id: entityId }, select: { mmgPayUrl: true, mmgPayUrlPending: true, mmgPayUrlApplyAt: true, userId: true } });
  if (!d) throw new AppError(404, 'NOT_FOUND', 'Driver not found');
  return { mmgPayUrl: d.mmgPayUrl, mmgPayUrlPending: d.mmgPayUrlPending, mmgPayUrlApplyAt: d.mmgPayUrlApplyAt, userId: d.userId };
}

/** A compare-and-set write on the entity: the authority moves only from the state this transition read. */
async function writeLink(
  tx: Tx, actor: LinkActor, entityId: string,
  expect: { mmgPayUrl: string | null },
  data: Record<string, unknown>,
): Promise<void> {
  const where = { id: entityId, mmgPayUrl: expect.mmgPayUrl };
  const r = actor === 'VENDOR' ? await tx.vendor.updateMany({ where, data }) : await tx.driver.updateMany({ where, data });
  if (r.count !== 1) {
    moneySurfaceCounter.labels('refused_authority_moved').inc();
    throw new AppError(409, 'AUTHORITY_MOVED', 'The pay link changed under this request; read it again.');
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

async function supersedeOpenStage(tx: Tx, entityId: string): Promise<void> {
  await tx.moneySurfaceCommand.updateMany({ where: { entityId, kind: 'MMG_LINK_STAGE', state: 'DECIDED' }, data: { state: 'SUPERSEDED' } });
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

/** The retry sweep, run by the cool-off job: every committed intent not yet sent. */
export async function deliverPendingMoneySurfaceNotices(deps: MoneySurfaceDeps, now = new Date()): Promise<{ delivered: number; pending: number }> {
  const rows = await deps.prisma.moneySurfaceCommand.findMany({
    where: { noticeKind: { not: null }, noticeSentAt: null, createdAt: { lt: new Date(now.getTime() - 15_000) }, noticeAttempts: { lt: 20 } },
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
  /** Already validated by utils/mmg-pay-url. */
  newUrl: string;
  now?: Date;
}

export async function stageMmgLinkChange(deps: MoneySurfaceDeps, input: StageInput): Promise<{ applyAt: Date; cooloffHours: number; signals: LinkSignal[]; commandId: string; replay: boolean }> {
  const now = input.now ?? new Date();
  // [R048-007] default-deny: when the control is reachable it is re-verified here; when it is not, the money surface refuses
  if (deps.redis) {
    let ok = false;
    try { ok = !!input.sessionId && (await hasStepUp(deps.redis, input.sessionId)); } catch { moneySurfaceCounter.labels('refused_control_unavailable').inc(); throw new AppError(503, 'CONTROL_UNAVAILABLE', 'The step-up check is unavailable right now; the pay link was not changed.'); }
    if (!ok) { moneySurfaceCounter.labels('refused_step_up').inc(); throw new AppError(403, 'STEP_UP_REQUIRED', 'Confirm it’s you first — we’ll text a code to the phone on this account.'); }
  }
  const cfg = await algoConfig(deps.prisma, 'money.linkCooloffHours');
  const cooloffHours = Math.min(72, Math.max(1, Number(cfg.value) || DEFAULT_LINK_COOLOFF_HOURS));
  const applyAt = new Date(now.getTime() + cooloffHours * 3_600_000);
  const sig = await sessionSignals(deps.prisma, input.userId, input.sessionId);
  const newDigest = digestOf(input.newUrl);
  const notice: OwnerNotice = {
    title: 'Your MMG pay link is changing',
    body: `The new link takes effect ${whenSentence(applyAt)}. If this wasn’t you, open Account and cancel it now — that also signs out every other device.`,
    kind: 'mmg_link_change_staged',
    sms: `Swift: the MMG pay link on your ${input.actor === 'VENDOR' ? 'store' : 'driver'} account changes ${whenSentence(applyAt)}. If this wasn't you, open Swift > Account and cancel it now.`,
    dedupeKey: `mmg-link-staged:${input.entityId}:${applyAt.toISOString()}`,
  };
  const result = await deps.prisma.$transaction(async (tx) => {
    await lockEntity(tx, input.entityId);
    const current = await readLink(tx, input.actor, input.entityId);
    await deps.failpoint?.('tx:after-read');
    const open = await tx.moneySurfaceCommand.findFirst({ where: { entityId: input.entityId, kind: 'MMG_LINK_STAGE', state: 'DECIDED' } });
    // replay convergence: the same change staged again is the same command, not a second one
    if (open && open.newDigest === newDigest && open.applyAt) {
      moneySurfaceCounter.labels('stage_replay').inc();
      return { command: open, replay: true, applyAt: open.applyAt };
    }
    if (open) await supersedeOpenStage(tx, input.entityId);
    const generation = await nextGeneration(tx, input.entityId);
    await writeLink(tx, input.actor, input.entityId, { mmgPayUrl: current.mmgPayUrl }, { mmgPayUrlPending: input.newUrl, mmgPayUrlPendingAt: now, mmgPayUrlApplyAt: applyAt });
    await deps.failpoint?.('tx:after-entity');
    const decisionId = await decide(tx, {
      algo: ALGO_ID, subjectType: input.actor, subjectId: input.entityId, outcome: 'STAGED',
      sentence: `MMG pay link change staged ${fromClause(sig.signals)}; the old link stays live until ${whenSentence(applyAt)} unless the owner cancels.`,
      inputs: {
        signals: sig.signals, sessionAgeMin: sig.sessionAgeMin, deviceId: sig.deviceId,
        hadLink: current.mmgPayUrl != null, newHost: hostOf(input.newUrl), cooloffHours, applyAt: applyAt.toISOString(), generation,
      },
      configVersion: cfg.version,
    });
    await deps.failpoint?.('tx:after-decision');
    const command = await writeCommand(tx, generation, {
      actor: input.actor, entityId: input.entityId, userId: input.userId, kind: 'MMG_LINK_STAGE', state: 'DECIDED',
      oldDigest: digestOf(current.mmgPayUrl), newDigest, decisionId, stepUpSessionId: input.sessionId, signals: sig.signals, applyAt, notice,
    });
    await deps.failpoint?.('tx:after-command');
    return { command, replay: false, applyAt };
  });
  moneySurfaceCounter.labels(result.replay ? 'stage_replay' : 'staged').inc();
  await deps.failpoint?.('after-commit');
  if (!result.replay) await deliverCommandNotice(deps, result.command);
  return { applyAt: result.applyAt, cooloffHours, signals: sig.signals, commandId: result.command.id, replay: result.replay };
}

export async function cancelMmgLinkChange(
  deps: MoneySurfaceDeps,
  input: { actor: LinkActor; entityId: string; userId: string; keepSessionId: string | null },
): Promise<{ cancelled: boolean; revokedSessions: number }> {
  const result = await deps.prisma.$transaction(async (tx) => {
    await lockEntity(tx, input.entityId);
    const current = await readLink(tx, input.actor, input.entityId);
    await deps.failpoint?.('tx:after-read');
    if (current.mmgPayUrlPending == null) return null;
    const generation = await nextGeneration(tx, input.entityId);
    await writeLink(tx, input.actor, input.entityId, { mmgPayUrl: current.mmgPayUrl }, CLEAR_PENDING);
    await deps.failpoint?.('tx:after-entity');
    // the revocation consequence is part of the same authority transition
    const revoked = await tx.session.deleteMany({
      where: { userId: input.userId, ...(input.keepSessionId ? { id: { not: input.keepSessionId } } : {}) },
    });
    await supersedeOpenStage(tx, input.entityId);
    await tx.moneySurfaceCommand.updateMany({ where: { entityId: input.entityId, kind: 'MMG_LINK_STAGE', state: 'SUPERSEDED', newDigest: digestOf(current.mmgPayUrlPending) }, data: { state: 'CANCELLED' } });
    const decisionId = await decide(tx, {
      algo: ALGO_ID, subjectType: input.actor, subjectId: input.entityId, outcome: 'CANCELLED_BY_OWNER',
      sentence: `The owner cancelled the pending MMG pay link change and ${revoked.count} other session${revoked.count === 1 ? ' was' : 's were'} signed out.`,
      inputs: { revokedSessions: revoked.count, generation },
    });
    await deps.failpoint?.('tx:after-decision');
    const command = await writeCommand(tx, generation, {
      actor: input.actor, entityId: input.entityId, userId: input.userId, kind: 'MMG_LINK_CANCEL', state: 'APPLIED',
      oldDigest: digestOf(current.mmgPayUrlPending), newDigest: digestOf(current.mmgPayUrl), decisionId, stepUpSessionId: input.keepSessionId,
      notice: {
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

export async function clearMmgLink(deps: MoneySurfaceDeps, input: { actor: LinkActor; entityId: string; userId?: string }): Promise<void> {
  await deps.prisma.$transaction(async (tx) => {
    await lockEntity(tx, input.entityId);
    const current = await readLink(tx, input.actor, input.entityId);
    await deps.failpoint?.('tx:after-read');
    const generation = await nextGeneration(tx, input.entityId);
    await writeLink(tx, input.actor, input.entityId, { mmgPayUrl: current.mmgPayUrl }, { mmgPayUrl: null, ...CLEAR_PENDING });
    await deps.failpoint?.('tx:after-entity');
    await supersedeOpenStage(tx, input.entityId);
    const decisionId = await decide(tx, {
      algo: ALGO_ID, subjectType: input.actor, subjectId: input.entityId, outcome: 'CLEARED',
      sentence: 'The MMG pay link was removed; the account is cash-only until a new link clears its cool-off.',
      inputs: { generation },
    });
    await deps.failpoint?.('tx:after-decision');
    await writeCommand(tx, generation, {
      actor: input.actor, entityId: input.entityId, userId: input.userId ?? current.userId, kind: 'MMG_LINK_CLEAR', state: 'APPLIED',
      oldDigest: digestOf(current.mmgPayUrl), newDigest: 'none', decisionId,
    });
    await deps.failpoint?.('tx:after-command');
  });
  moneySurfaceCounter.labels('cleared').inc();
}

/**
 * The executor: applies only DECIDED stage commands it has LEASED, each in
 * its own transaction under the entity lock. A staged row with no command —
 * staged before this record existed — is applied the same way and given its
 * command at application, so the audit generation still counts it.
 */
export async function applyDueMmgLinkChanges(deps: MoneySurfaceDeps, now = new Date()): Promise<{ applied: number }> {
  let applied = 0;
  const due: Array<{ actor: LinkActor; id: string }> = [];
  const vendors = await deps.prisma.vendor.findMany({ where: { mmgPayUrlApplyAt: { lte: now }, mmgPayUrlPending: { not: null } }, select: { id: true }, take: 200 });
  const drivers = await deps.prisma.driver.findMany({ where: { mmgPayUrlApplyAt: { lte: now }, mmgPayUrlPending: { not: null } }, select: { id: true }, take: 200 });
  due.push(...vendors.map((v) => ({ actor: 'VENDOR' as const, id: v.id })), ...drivers.map((d) => ({ actor: 'DRIVER' as const, id: d.id })));
  for (const item of due) {
    // lease the command (when there is one) so two executors never apply the same change
    const open = await deps.prisma.moneySurfaceCommand.findFirst({ where: { entityId: item.id, kind: 'MMG_LINK_STAGE', state: 'DECIDED' } });
    if (open) {
      const leased = await deps.prisma.moneySurfaceCommand.updateMany({
        where: { id: open.id, state: 'DECIDED', OR: [{ leasedUntil: null }, { leasedUntil: { lt: now } }] },
        data: { leasedUntil: new Date(now.getTime() + APPLY_LEASE_MS) },
      });
      if (leased.count !== 1) { moneySurfaceCounter.labels('apply_lease_missed').inc(); continue; }
    }
    const done = await deps.prisma.$transaction(async (tx) => {
      await lockEntity(tx, item.id);
      const current = await readLink(tx, item.actor, item.id);
      await deps.failpoint?.('tx:after-read');
      if (!current.mmgPayUrlPending || !current.mmgPayUrlApplyAt || current.mmgPayUrlApplyAt > now) return false;
      const stage = await tx.moneySurfaceCommand.findFirst({ where: { entityId: item.id, kind: 'MMG_LINK_STAGE', state: 'DECIDED' } });
      if (open && (!stage || stage.id !== open.id)) return false; // moved under us: cancelled or superseded
      const generation = await nextGeneration(tx, item.id);
      await writeLink(tx, item.actor, item.id, { mmgPayUrl: current.mmgPayUrl }, { mmgPayUrl: current.mmgPayUrlPending, ...CLEAR_PENDING });
      await deps.failpoint?.('tx:after-entity');
      if (stage) await tx.moneySurfaceCommand.update({ where: { id: stage.id }, data: { state: 'APPLIED', appliedAt: now, leasedUntil: null } });
      const decisionId = await decide(tx, {
        algo: ALGO_ID, subjectType: item.actor, subjectId: item.id, outcome: 'APPLIED',
        sentence: 'The staged MMG pay link went live after its cool-off passed without a cancellation.',
        inputs: { applyAt: current.mmgPayUrlApplyAt.toISOString(), newHost: hostOf(current.mmgPayUrlPending), generation, legacy: !stage },
      });
      await deps.failpoint?.('tx:after-decision');
      const command = await writeCommand(tx, generation, {
        actor: item.actor, entityId: item.id, userId: current.userId, kind: 'MMG_LINK_APPLY', state: 'APPLIED',
        oldDigest: digestOf(current.mmgPayUrl), newDigest: digestOf(current.mmgPayUrlPending), decisionId, stepUpSessionId: stage?.stepUpSessionId ?? null,
        notice: {
          title: 'Your new MMG pay link is live',
          body: item.actor === 'VENDOR' ? 'Customers paying by MMG now pay to the link you set.' : 'Riders paying by MMG now pay to the link you set.',
          kind: 'mmg_link_change_applied',
          dedupeKey: `mmg-link-applied:${item.id}:${current.mmgPayUrlApplyAt.toISOString()}`,
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
export async function moneySurfaceInventory(prisma: PrismaClient): Promise<{ openStages: number; unsentNotices: number; appliedWithoutDecision: number }> {
  const [openStages, unsentNotices, appliedWithoutDecision] = await Promise.all([
    prisma.moneySurfaceCommand.count({ where: { kind: 'MMG_LINK_STAGE', state: 'DECIDED' } }),
    prisma.moneySurfaceCommand.count({ where: { noticeKind: { not: null }, noticeSentAt: null } }),
    prisma.moneySurfaceCommand.count({ where: { state: 'APPLIED', decisionId: null } }),
  ]);
  return { openStages, unsentNotices, appliedWithoutDecision };
}
