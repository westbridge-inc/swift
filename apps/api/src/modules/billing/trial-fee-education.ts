import { lockFeeCollectionAuthority } from '../subscription/mover-fee-authority';
import type { PrismaClient } from '@prisma/client';
import type { NotificationService } from '../notification/notification.service';
import { payInfo } from './agent-cash.service';
import { feeCoveredLine, feeDueLine, mmgPayLine } from './fee-notice-copy';
import { checkoutAmountGyd, mmgCheckoutLive } from './fee-pay-actions';
import { feePauseHoldsBilling, feePauseSpanOpen } from './mmg-pause';

// Trial first-payment funnel [san spec 21.4]: the first fee, told before the
// first bill ever exists. Day 10 (trial end − 4d) and day 13 (− 1d): the exact
// GY$ and when it is due, and — only while the MMG checkout is live — the one
// way to pay it, the checkout in the Swift app (fee-notice-copy.ts; never an
// agent, cash or a Swift Number: the owner's rule of 2026-09-29). A wallet
// that already covers the fee is told so, never asked to pay again. Dedup
// rides the same BillingEvent unique-key idiom as every other reminder —
// restart and overlap safe. first_payment_before_trial_end is THE pilot
// metric; it derives from rows this sequence leaves behind.

const DAY_MS = 86_400_000;

export async function sweepTrialFeeEducation(
  prisma: PrismaClient,
  notifications: NotificationService,
  now = new Date(),
): Promise<{ day10: number; day13: number }> {
  const out = { day10: 0, day13: 0 };
  // [PROD-PATH] No live way to pay: the fee is paused, so naming the amount
  // and the date it is due would be untrue. Nothing is written, so a stage
  // still goes out if a way to pay comes back inside its window.
  if (await feePauseSpanOpen(prisma)) return out;
  const trials = await prisma.subscription.findMany({
    where: {
      status: 'TRIAL',
      isTrialActive: true,
      feeWaived: false,
      trialEndDate: { gt: now, lte: new Date(now.getTime() + 4 * DAY_MS) },
    },
    include: {
      rider: { select: { userId: true } },
      driver: { select: { userId: true } },
      vendor: { select: { owner: { select: { userId: true } } } },
    },
    take: 500,
  });

  for (const sub of trials) {
    const daysLeft = Math.ceil((sub.trialEndDate!.getTime() - now.getTime()) / DAY_MS);
    const stage = daysLeft <= 1 ? 'd13' : 'd10';
    const userId = sub.rider?.userId ?? sub.driver?.userId ?? sub.vendor?.owner.userId;
    if (!userId) continue;
    try {
      const allowed = await prisma.$transaction(async (tx) => {
        if (!(await lockFeeCollectionAuthority(tx, sub.id)).allowed) return false;
        if (await feePauseHoldsBilling(tx, sub.id)) return false;
        await tx.billingEvent.create({
        data: {
          subscriptionId: sub.id,
          type: 'REMINDER',
          currencyCode: sub.currencyCode,
          idempotencyKey: `trialedu:${sub.id}:${stage}`,
          note: stage === 'd10' ? 'Trial fee education (day 10)' : 'Trial fee reminder with amount (day 13)',
        },
        });
        return true;
      });
      if (!allowed) continue;
    } catch (error) {
      if ((error as { code?: string }).code !== 'P2002') throw error;
      // A saved stage whose delivery was interrupted still enters the durable outbox.
    }
    const fee = await payInfo(prisma, sub);
    const payLine = fee.amountDueGyd <= 0
      ? feeCoveredLine(fee.weeklyFeeGyd, sub.currencyCode, { first: true })
      : await mmgCheckoutLive(prisma, sub, 'unknown')
        ? mmgPayLine(checkoutAmountGyd(fee))
        : feeDueLine(fee.amountDueGyd, sub.currencyCode, sub.trialEndDate, { first: true });
    const audience = sub.vendor ? 'VENDOR' : 'MOVER';
    if (stage === 'd10') {
      await notifications.send({
        userId,
        type: 'SYSTEM_ANNOUNCEMENT',
        title: 'Your trial ends soon',
        body: `Your trial ends on ${sub.trialEndDate!.toISOString().slice(0, 10)}. ${payLine}`,
        audience: audience as never,
        data: { kind: 'trial_fee_education', subscriptionId: sub.id, stage },
        feeStageKey: `trial:${stage}`,
      });
      out.day10 += 1;
    } else {
      await notifications.send({
        userId,
        type: 'SYSTEM_ANNOUNCEMENT',
        title: 'Your trial ends soon',
        body: `Your trial ends on ${sub.trialEndDate!.toISOString().slice(0, 10)}. ${payLine}`,
        audience: audience as never,
        data: { kind: 'trial_fee_education', subscriptionId: sub.id, stage },
        feeStageKey: `trial:${stage}`,
      });
      out.day13 += 1;
    }
  }
  return out;
}

/** THE pilot metric [21.4]: of trials that ended in the window, how many had
 *  loaded the wallet (or paid) BEFORE trial end — derived from rows, not
 *  tracking calls. */
export async function firstPaymentFunnel(prisma: PrismaClient, days = 30) {
  const since = new Date(Date.now() - days * DAY_MS);
  const ended = await prisma.subscription.findMany({
    where: { trialEndDate: { gte: since, lte: new Date() }, feeWaived: false },
    select: { id: true, trialEndDate: true },
  });
  if (ended.length === 0) return { windowDays: days, trialsEnded: 0, paidBeforeEnd: 0, paidWithin7d: 0 };
  const ids = ended.map((s) => s.id);
  const endBy = new Map(ended.map((s) => [s.id, s.trialEndDate!.getTime()]));
  const topups = await prisma.billingEvent.findMany({
    where: { subscriptionId: { in: ids }, type: 'PREPAID_TOPUP' },
    select: { subscriptionId: true, createdAt: true },
  });
  const paidBeforeEnd = new Set(topups.filter((t) => t.createdAt.getTime() <= (endBy.get(t.subscriptionId) ?? 0)).map((t) => t.subscriptionId)).size;
  const paidWithin7d = new Set(topups.filter((t) => t.createdAt.getTime() <= (endBy.get(t.subscriptionId) ?? 0) + 7 * DAY_MS).map((t) => t.subscriptionId)).size;
  return { windowDays: days, trialsEnded: ended.length, paidBeforeEnd, paidWithin7d };
}
