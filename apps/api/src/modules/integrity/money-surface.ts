import type { PrismaClient } from '@prisma/client';
import type { Server } from 'socket.io';
import { algoConfig } from '../algo/algo-config';
import { recordDecision } from '../algo/decisions';
import { NotificationService } from '../notification/notification.service';
import { getChannels } from '../../providers/notifications/channels';
import { log } from '../../utils/logger';

/**
 * [ALG-34 / ALG-INV-14] The MMG pay link is where a store's (or a taxi
 * driver's) money goes. Changing it is hostile until proven:
 *
 *   1. step-up first (auth/step-up.ts — the route refuses without it),
 *   2. the change is STAGED, not applied: the old link keeps paying the owner
 *      for the cool-off (`money.linkCooloffHours`, default 24),
 *   3. the OLD contact point is told — SMS to the account phone and a push to
 *      every device with a session — with a one-tap cancel that also signs
 *      out every other device,
 *   4. the cool-off job applies the change only if nobody cancelled.
 *
 * Every step is an AlgoDecision row (ALG-34) with the session signals that
 * were measurable: a device never seen on this account before, an IP never
 * seen before. Impossible travel is NOT measured — sessions carry no
 * geography — and a signal that cannot be measured is not manufactured.
 * Sessions swept by logout or expiry make a device look new again; that
 * reads as a signal for a reviewer, never as a block — the step-up already
 * happened.
 *
 * Clearing the link (back to cash-only) is immediate: it redirects nothing.
 */

export type LinkActor = 'VENDOR' | 'DRIVER';
export type LinkSignal = 'NEW_DEVICE' | 'NEW_IP';
export const ALGO_ID = 'ALG-34';
export const DEFAULT_LINK_COOLOFF_HOURS = 24;

export interface MoneySurfaceDeps {
  prisma: PrismaClient;
  io: Server;
}

const CLEAR_PENDING = { mmgPayUrlPending: null, mmgPayUrlPendingAt: null, mmgPayUrlApplyAt: null } as const;

export function whenSentence(at: Date): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'America/Guyana', weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true,
  }).format(at);
}

const hostOf = (url: string): string => { try { return new URL(url).host; } catch { return 'invalid'; } };

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

async function notifyOwner(deps: MoneySurfaceDeps, actor: LinkActor, userId: string, notice: OwnerNotice): Promise<void> {
  await new NotificationService(deps.prisma, deps.io).send({
    userId,
    type: 'SYSTEM_ANNOUNCEMENT',
    title: notice.title,
    body: notice.body,
    data: { kind: notice.kind, actor },
    ...(notice.dedupeKey ? { dedupeKey: notice.dedupeKey } : {}),
  }).catch((err: unknown) => log().warn({ err, userId }, 'money-surface: push/inbox notice failed'));
  if (notice.sms) {
    try {
      const user = await deps.prisma.user.findUnique({ where: { id: userId }, select: { phone: true } });
      if (user?.phone) await getChannels().sms.sendSms(user.phone, notice.sms);
    } catch (err) {
      log().warn({ err, userId }, 'money-surface: SMS notice failed');
    }
  }
}

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

export async function stageMmgLinkChange(deps: MoneySurfaceDeps, input: StageInput): Promise<{ applyAt: Date; cooloffHours: number; signals: LinkSignal[] }> {
  const now = input.now ?? new Date();
  const cfg = await algoConfig(deps.prisma, 'money.linkCooloffHours');
  const cooloffHours = Math.min(72, Math.max(1, Number(cfg.value) || DEFAULT_LINK_COOLOFF_HOURS));
  const applyAt = new Date(now.getTime() + cooloffHours * 3_600_000);
  const data = { mmgPayUrlPending: input.newUrl, mmgPayUrlPendingAt: now, mmgPayUrlApplyAt: applyAt };
  const before = input.actor === 'VENDOR'
    ? await deps.prisma.vendor.update({ where: { id: input.entityId }, data, select: { mmgPayUrl: true } })
    : await deps.prisma.driver.update({ where: { id: input.entityId }, data, select: { mmgPayUrl: true } });

  const sig = await sessionSignals(deps.prisma, input.userId, input.sessionId);
  await recordDecision(deps.prisma, {
    algo: ALGO_ID,
    subjectType: input.actor,
    subjectId: input.entityId,
    outcome: 'STAGED',
    sentence: `MMG pay link change staged ${fromClause(sig.signals)}; the old link stays live until ${whenSentence(applyAt)} unless the owner cancels.`,
    inputs: {
      signals: sig.signals, sessionAgeMin: sig.sessionAgeMin, deviceId: sig.deviceId,
      hadLink: before.mmgPayUrl != null, newHost: hostOf(input.newUrl), cooloffHours, applyAt: applyAt.toISOString(),
    },
    configVersion: cfg.version,
  });

  const surface = input.actor === 'VENDOR' ? 'store' : 'driver';
  await notifyOwner(deps, input.actor, input.userId, {
    title: 'Your MMG pay link is changing',
    body: `The new link takes effect ${whenSentence(applyAt)}. If this wasn’t you, open Account and cancel it now — that also signs out every other device.`,
    kind: 'mmg_link_change_staged',
    sms: `Swift: the MMG pay link on your ${surface} account changes ${whenSentence(applyAt)}. If this wasn't you, open Swift > Account and cancel it now.`,
    dedupeKey: `mmg-link-staged:${input.entityId}:${applyAt.toISOString()}`,
  });
  return { applyAt, cooloffHours, signals: sig.signals };
}

export async function cancelMmgLinkChange(
  deps: MoneySurfaceDeps,
  input: { actor: LinkActor; entityId: string; userId: string; keepSessionId: string | null },
): Promise<{ cancelled: boolean; revokedSessions: number }> {
  const where = { id: input.entityId, mmgPayUrlPending: { not: null } };
  const res = input.actor === 'VENDOR'
    ? await deps.prisma.vendor.updateMany({ where, data: CLEAR_PENDING })
    : await deps.prisma.driver.updateMany({ where, data: CLEAR_PENDING });
  const cancelled = res.count > 0;
  if (!cancelled) return { cancelled: false, revokedSessions: 0 };

  // "This wasn't me": every OTHER session of the account is signed out — the
  // one that staged the change included. The cancelling device keeps its own.
  const revoked = await deps.prisma.session.deleteMany({
    where: { userId: input.userId, ...(input.keepSessionId ? { id: { not: input.keepSessionId } } : {}) },
  });
  await recordDecision(deps.prisma, {
    algo: ALGO_ID, subjectType: input.actor, subjectId: input.entityId, outcome: 'CANCELLED_BY_OWNER',
    sentence: `The owner cancelled the pending MMG pay link change and ${revoked.count} other session${revoked.count === 1 ? ' was' : 's were'} signed out.`,
    inputs: { revokedSessions: revoked.count },
  });
  await notifyOwner(deps, input.actor, input.userId, {
    title: 'MMG pay link change cancelled',
    body: `The pending change was cancelled and ${revoked.count} other device${revoked.count === 1 ? ' was' : 's were'} signed out. Your current link stays as it was.`,
    kind: 'mmg_link_change_cancelled',
  });
  return { cancelled: true, revokedSessions: revoked.count };
}

/** Back to cash-only: immediate, and it drops any pending change with it. */
export async function clearMmgLink(deps: MoneySurfaceDeps, input: { actor: LinkActor; entityId: string }): Promise<void> {
  const data = { mmgPayUrl: null, ...CLEAR_PENDING };
  if (input.actor === 'VENDOR') await deps.prisma.vendor.update({ where: { id: input.entityId }, data });
  else await deps.prisma.driver.update({ where: { id: input.entityId }, data });
  await recordDecision(deps.prisma, {
    algo: ALGO_ID, subjectType: input.actor, subjectId: input.entityId, outcome: 'CLEARED',
    sentence: 'The MMG pay link was removed; the account is cash-only until a new link clears its cool-off.',
    inputs: {},
  });
}

/** The cool-off job: apply every staged change whose time has come and that nobody cancelled. */
export async function applyDueMmgLinkChanges(deps: MoneySurfaceDeps, now = new Date()): Promise<{ applied: number }> {
  let applied = 0;
  const dueVendors = await deps.prisma.vendor.findMany({
    where: { mmgPayUrlApplyAt: { lte: now }, mmgPayUrlPending: { not: null } },
    select: { id: true, mmgPayUrlPending: true, mmgPayUrlApplyAt: true, owner: { select: { userId: true } } },
    take: 200,
  });
  for (const v of dueVendors) {
    // CAS on applyAt: a cancel or a re-stage that raced us wins.
    const r = await deps.prisma.vendor.updateMany({
      where: { id: v.id, mmgPayUrlApplyAt: v.mmgPayUrlApplyAt },
      data: { mmgPayUrl: v.mmgPayUrlPending, ...CLEAR_PENDING },
    });
    if (!r.count) continue;
    applied += 1;
    await recordDecision(deps.prisma, {
      algo: ALGO_ID, subjectType: 'VENDOR', subjectId: v.id, outcome: 'APPLIED',
      sentence: 'The staged MMG pay link went live after its cool-off passed without a cancellation.',
      inputs: { applyAt: v.mmgPayUrlApplyAt?.toISOString() ?? null, newHost: hostOf(v.mmgPayUrlPending ?? '') },
    });
    await notifyOwner(deps, 'VENDOR', v.owner.userId, {
      title: 'Your new MMG pay link is live',
      body: 'Customers paying by MMG now pay to the link you set.',
      kind: 'mmg_link_change_applied',
      dedupeKey: `mmg-link-applied:${v.id}:${v.mmgPayUrlApplyAt?.toISOString() ?? ''}`,
    });
  }

  const dueDrivers = await deps.prisma.driver.findMany({
    where: { mmgPayUrlApplyAt: { lte: now }, mmgPayUrlPending: { not: null } },
    select: { id: true, userId: true, mmgPayUrlPending: true, mmgPayUrlApplyAt: true },
    take: 200,
  });
  for (const d of dueDrivers) {
    const r = await deps.prisma.driver.updateMany({
      where: { id: d.id, mmgPayUrlApplyAt: d.mmgPayUrlApplyAt },
      data: { mmgPayUrl: d.mmgPayUrlPending, ...CLEAR_PENDING },
    });
    if (!r.count) continue;
    applied += 1;
    await recordDecision(deps.prisma, {
      algo: ALGO_ID, subjectType: 'DRIVER', subjectId: d.id, outcome: 'APPLIED',
      sentence: 'The staged MMG pay link went live after its cool-off passed without a cancellation.',
      inputs: { applyAt: d.mmgPayUrlApplyAt?.toISOString() ?? null, newHost: hostOf(d.mmgPayUrlPending ?? '') },
    });
    await notifyOwner(deps, 'DRIVER', d.userId, {
      title: 'Your new MMG pay link is live',
      body: 'Riders paying by MMG now pay to the link you set.',
      kind: 'mmg_link_change_applied',
      dedupeKey: `mmg-link-applied:${d.id}:${d.mmgPayUrlApplyAt?.toISOString() ?? ''}`,
    });
  }
  return { applied };
}
