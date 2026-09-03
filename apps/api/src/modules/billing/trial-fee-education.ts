import type { PrismaClient } from '@prisma/client';
import type { NotificationService } from '../notification/notification.service';
import { formatSan } from './san';
import { ensureSan } from './san.service';
import { weeklyFeeAmount } from './subscription-fee';

// Trial first-payment funnel [san spec 21.4]: teach HOW to pay before the
// first bill ever exists. Day 10 (trial end − 4d): "how you'll pay your
// weekly fee" with the agent steps + their Swift Number. Day 13 (− 1d): the
// exact GY$ and the nudge to preload so conversion is seamless. Dedup rides
// the same BillingEvent unique-key idiom as every other reminder — restart
// and overlap safe. first_payment_before_trial_end is THE pilot metric; it
// derives from rows this sequence leaves behind.

const DAY_MS = 86_400_000;

export async function sweepTrialFeeEducation(
  prisma: PrismaClient,
  notifications: NotificationService,
  now = new Date(),
): Promise<{ day10: number; day13: number }> {
  const out = { day10: 0, day13: 0 };
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
      await prisma.billingEvent.create({
        data: {
          subscriptionId: sub.id,
          type: 'REMINDER',
          currencyCode: sub.currencyCode,
          idempotencyKey: `trialedu:${sub.id}:${stage}`,
          note: stage === 'd10' ? 'Trial fee education (day 10)' : 'Trial fee reminder with amount (day 13)',
        },
      });
    } catch {
      continue; // this stage already sent — the unique key is the gate
    }
    const san = formatSan(await ensureSan(prisma, sub.id));
    const weekly = weeklyFeeAmount(sub);
    const audience = sub.vendor ? 'VENDOR' : 'MOVER';
    if (stage === 'd10') {
      await notifications.send({
        userId,
        type: 'SYSTEM_ANNOUNCEMENT',
        title: 'How you’ll pay your weekly fee',
        body: `Your trial ends in ${daysLeft} days. Pay cash at any MMG agent — say you’re paying a Swift bill and give your Swift Number ${san}. Load it before your trial ends and service continues without a beat.`,
        audience: audience as never,
        data: { kind: 'trial_fee_education', subscriptionId: sub.id, stage },
      });
      out.day10 += 1;
    } else {
      await notifications.send({
        userId,
        type: 'SYSTEM_ANNOUNCEMENT',
        title: 'Your trial ends tomorrow',
        body: `Your first weekly fee is GY$${weekly.toLocaleString()}. Pay cash at any MMG agent with your Swift Number ${san} — pay today and you won’t be interrupted.`,
        audience: audience as never,
        data: { kind: 'trial_fee_education', subscriptionId: sub.id, stage },
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
