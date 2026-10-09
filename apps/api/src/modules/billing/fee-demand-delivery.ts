import { billingEffectsReady } from './billing-cutover';
import type { BillingFeeNotice, Prisma, PrismaClient } from '@prisma/client';
import type { NotificationPayload } from '../notification/notification.service';
import { currentDunningClock, lockBillingAuthority } from './dunning-clock';
import { feePauseHoldsBilling } from './mmg-pause';

const FEE_DEMAND_KINDS = new Set([
  'billing_failed', 'billing_final_warning', 'billing_suspended',
  'billing_suspended_nudge', 'billing_churned', 'billing_reminder', 'trial_fee_education', 'billing_dunning_ops_task',
]);
/** An ops task goes to the payer's own tenant operators: notifyAdmins pages
 * ADMIN and SUPER_ADMIN alike, so either role is a valid recipient. */
const isOperator = (roles: readonly string[]) => roles.includes('ADMIN') || roles.includes('SUPER_ADMIN');
export function isFeeDemand(payload: NotificationPayload): boolean {
  return FEE_DEMAND_KINDS.has(String(payload.data?.['kind']));
}

/** Enqueue even while paused. The original stage identity survives resume;
 * advancing the paid obligation makes its old pending stages obsolete. */
export async function enqueueFeeDemand(db: PrismaClient, payload: NotificationPayload): Promise<BillingFeeNotice> {
  const subscriptionId = payload.data?.['subscriptionId'];
  if (typeof subscriptionId !== 'string') throw new Error('Fee demand has no subscription');
  return db.$transaction((tx) => enqueueFeeDemandInTx(tx, payload));
}

export async function enqueueFeeDemandInTx(tx: Prisma.TransactionClient, payload: NotificationPayload): Promise<BillingFeeNotice> {
    const subscriptionId = payload.data?.['subscriptionId'];
    if (typeof subscriptionId !== 'string') throw new Error('Fee demand has no subscription');
    const { sub, tenantId, userId: payerUserId } = await lockBillingAuthority(tx, subscriptionId);
    const userId = payload.userId;
    const kind = String(payload.data?.['kind']);
    const recipient = await tx.user.findUnique({ where: { id: userId }, select: { tenantId: true, roles: true } });
    if (!recipient || recipient.tenantId !== tenantId || (kind === 'billing_dunning_ops_task'
      ? !isOperator(recipient.roles) : payerUserId !== userId)) throw new Error('Fee demand recipient changed');
    const clock = await currentDunningClock(tx, subscriptionId);
    if (clock.subscriptionId !== subscriptionId) throw new Error('Fee demand names a historical source');
    const stageKey = payload.feeStageKey ?? payload.dedupeKey ?? `${kind}:a${sub.failedAttempts}`;
    await tx.billingFeeNotice.updateMany({ where: {
      clockId: clock.id, epoch: clock.epoch, userId, status: 'PENDING', stageKey: { not: stageKey },
      payload: { path: ['data', 'kind'], equals: kind },
    }, data: { status: 'OBSOLETE' } });
    return tx.billingFeeNotice.upsert({
      where: { clockId_epoch_stageKey_userId: { clockId: clock.id, epoch: clock.epoch, stageKey, userId } },
      create: { tenantId, subscriptionId, clockId: clock.id, epoch: clock.epoch, stageKey, userId,
        payload: JSON.parse(JSON.stringify(payload)) as Prisma.InputJsonValue },
      update: {},
    });
}

async function permitted(tx: Prisma.TransactionClient, noticeId: string) {
  if (!await billingEffectsReady(tx)) return null;
  const notice = await tx.billingFeeNotice.findUnique({ where: { id: noticeId } });
  if (!notice || notice.status === 'OBSOLETE') return null;
  // Recheck at inbox persistence AND each transport handoff. Generation may
  // have happened before the switch, and a future-due clock need not be paused.
  if (await feePauseHoldsBilling(tx, notice.subscriptionId)) return null;
  const clock = await currentDunningClock(tx, notice.subscriptionId);
  if (clock.id !== notice.clockId) throw new Error('Fee notice clock identity changed');
  const { sub, userId, userStatus } = await lockBillingAuthority(tx, clock.subscriptionId);
  const payload = notice.payload as unknown as NotificationPayload;
  const kind = payload.data?.['kind'];
  const admin = kind === 'billing_dunning_ops_task'
    ? await tx.user.findUnique({ where: { id: notice.userId }, select: { tenantId: true, roles: true, status: true } }) : null;
  const recipientValid = admin ? admin.tenantId === notice.tenantId && isOperator(admin.roles) && admin.status === 'ACTIVE' : userId === notice.userId;
  if (clock.epoch !== notice.epoch || !recipientValid || userStatus !== 'ACTIVE' || !sub.autoRenew
    || ['CANCELLED', 'PAUSED'].includes(sub.status)) {
    if (notice.status === 'PENDING') await tx.billingFeeNotice.update({ where: { id: noticeId }, data: { status: 'OBSOLETE' } });
    return null;
  }
  if (clock.pausedAt) return null;
  const stale = (kind === 'trial_fee_education' && sub.status !== 'TRIAL')
    || (kind === 'billing_reminder' && !['ACTIVE', 'TRIAL'].includes(sub.status))
    || ((kind === 'billing_suspended' || kind === 'billing_suspended_nudge') && sub.status !== 'SUSPENDED')
    || (kind === 'billing_churned' && sub.status !== 'CHURNED')
    || ((kind === 'billing_failed' || kind === 'billing_final_warning' || kind === 'billing_dunning_ops_task') && sub.status !== 'PAST_DUE');
  if (stale) {
    await tx.billingFeeNotice.update({ where: { id: noticeId }, data: { status: 'OBSOLETE' } });
    return null;
  }
  return notice;
}

export async function persistFeeDemandInbox(db: PrismaClient, noticeId: string): Promise<string | null> {
  return db.$transaction(async (tx) => {
    const notice = await permitted(tx, noticeId);
    if (!notice) return null;
    const payload = notice.payload as unknown as NotificationPayload;
    const row = await tx.notification.upsert({
      where: { userId_dedupeKey: { userId: notice.userId, dedupeKey: `fee-demand:${notice.id}` } },
      update: {},
      create: { userId: notice.userId, type: payload.type, title: payload.title, body: payload.body,
        dedupeKey: `fee-demand:${notice.id}`,
        data: { ...(payload.data ?? {}), ...(payload.audience ? { audience: payload.audience } : {}), feeDemandId: notice.id } as Prisma.InputJsonValue },
    });
    return row.id;
  });
}

/** UNKNOWN commits before the effect. A second transaction locks the same
 * payer/clock as hold creation, rechecks, and starts the provider call while
 * those locks are held. It commits without waiting on the network. Process
 * death or a lost acknowledgement never licenses a duplicate fee demand. */
export async function handOffFeeDemand<T>(
  db: PrismaClient, noticeId: string, channel: string, part: string, effect: () => Promise<T>,
): Promise<T | undefined> {
  const reserved = await db.$transaction(async (tx) => {
    const notice = await permitted(tx, noticeId);
    if (!notice) {
      const pending = await tx.billingFeeNotice.findUnique({ where: { id: noticeId } });
      if (pending?.status === 'PENDING') await tx.billingNoticeHandoff.upsert({
        where: { noticeId_channel_part: { noticeId, channel, part } },
        create: { tenantId: pending.tenantId, noticeId, channel, part, status: 'NOT_SENT' }, update: {},
      });
      return null;
    }
    const where = { noticeId_channel_part: { noticeId, channel, part } };
    const previous = await tx.billingNoticeHandoff.findUnique({ where });
    if (previous && previous.status !== 'NOT_SENT') return null;
    return tx.billingNoticeHandoff.upsert({ where,
      create: { tenantId: notice.tenantId, noticeId, channel, part, status: 'UNKNOWN' },
      update: { status: 'UNKNOWN', completedAt: null },
    });
  });
  if (!reserved) return undefined;
  let submitted: Promise<{ ok: true; value: T } | { ok: false; error: unknown }> | undefined;
  try {
    await db.$transaction(async (tx) => {
      if (!await permitted(tx, noticeId)) {
        await tx.billingNoticeHandoff.update({ where: { id: reserved.id }, data: { status: 'NOT_SENT' } });
        return;
      }
      // Attach both handlers immediately; a quick rejection must not become an
      // unhandled rejection while the database transaction is committing.
      try {
        submitted = effect().then((value) => ({ ok: true as const, value }), (error: unknown) => ({ ok: false as const, error }));
      } catch (error) {
        submitted = Promise.resolve({ ok: false as const, error });
      }
    });
  } catch (error) {
    // [#1393] The authorization failed before the provider call started: the
    // reservation is provably unsent, so a later attempt may still make it.
    // Once the call has started, UNKNOWN stays (never blindly resent).
    if (!submitted) {
      await db.billingNoticeHandoff.updateMany({ where: { id: reserved.id, status: 'UNKNOWN' }, data: { status: 'NOT_SENT' } }).catch(() => undefined);
    }
    throw error;
  }
  if (!submitted) return undefined;
  const result = await submitted;
  if (!result.ok) throw result.error; // UNKNOWN is durable; never blindly retry.
  await db.billingNoticeHandoff.update({ where: { id: reserved.id }, data: { status: 'DELIVERED', completedAt: new Date() } });
  return result.value;
}

export async function feeDemandOutstanding(db: PrismaClient, noticeId: string): Promise<boolean> {
  const notice = await db.billingFeeNotice.findUnique({ where: { id: noticeId } });
  if (!notice || notice.status === 'OBSOLETE') return false;
  return !!await db.billingNoticeHandoff.findFirst({ where: { noticeId, status: { in: ['NOT_SENT', 'UNKNOWN'] } } });
}
