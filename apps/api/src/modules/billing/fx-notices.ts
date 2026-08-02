import type { PrismaClient } from '@prisma/client';
import type { Server } from 'socket.io';
import { NotificationService } from '../notification/notification.service';
import { convertUsdToLocal, noticeRequired, formatMoney, resolveRateForRun } from './fx';
import { log } from '../../utils/logger';

// System 2 Part 12 — the >2% notice rule: when a fee payer's NEXT local
// amount will differ >2% from their LAST charged amount (an FX move), they
// hear about it ≥7 days before the invoice, framed the only honest way:
// "Your weekly fee stays US$25.00 — the GY$ amount changes to GY$5,300 from
// {date} (exchange-rate update)." The price didn't change; the conversion did.
//
// Runs as a daily job. Deduped per (subscription, rate) — one notice per rate
// change, not one per day. Only meaningful when usdPricingEnabled; a no-op
// otherwise. Reads the SAME conversion function billing charges with — the
// notice can never disagree with the eventual charge.

const SUB_ROLE: Record<string, string> = {
  RESTAURANT: 'VENDOR', SUPERMARKET: 'VENDOR', RETAIL_STORE: 'VENDOR',
  SERVICE_PROVIDER: 'SERVICE', DELIVERY_RIDER: 'RIDER', COURIER_RIDER: 'RIDER', TAXI_DRIVER: 'DRIVER',
};

export async function runFxChangeNotices(prisma: PrismaClient, io: Server, now = new Date()): Promise<{ notified: number }> {
  const tenant = await prisma.tenantBillingCurrency.findUnique({ where: { tenantId: 'swift-default' } });
  if (!tenant?.usdPricingEnabled) return { notified: 0 };
  const rate = await resolveRateForRun(prisma, tenant.settlementCurrency);
  if (!rate) return { notified: 0 };

  const entries = await prisma.priceBookEntry.findMany({ where: { active: true } });
  const book = new Map<string, number>();
  for (const e of entries) book.set(`${e.role}|${e.tier ?? ''}`, Number(e.amountUsd));

  // Fee payers whose next bill is ≥7 days out — the notice window the rule
  // promises. Closer-in bills already priced under the previous rate carry on.
  const inSevenDays = new Date(now.getTime() + 7 * 86_400_000);
  const subs = await prisma.subscription.findMany({
    where: {
      autoRenew: true,
      customRate: null, // explicit local overrides are outside the USD book
      status: { in: ['ACTIVE', 'TRIAL'] },
      nextBillingDate: { gte: inSevenDays },
    },
    include: {
      rider: { select: { userId: true } },
      driver: { select: { userId: true } },
      vendor: { select: { owner: { select: { userId: true } } } },
    },
  });

  const notifications = new NotificationService(prisma, io);
  let notified = 0;
  for (const sub of subs) {
    const role = SUB_ROLE[sub.type] ?? 'VENDOR';
    const amountUsd = book.get(`${role}|${sub.type}`) ?? book.get(`${role}|`);
    if (amountUsd === undefined) continue;

    // "Last amount" = the most recent successful charge; a payer who never
    // paid yet has nothing to compare against (their first bill needs no
    // change notice — there is no change).
    const lastCharge = await prisma.billingEvent.findFirst({
      where: { subscriptionId: sub.id, type: 'CHARGE_SUCCESS', amount: { not: null } },
      orderBy: { createdAt: 'desc' },
      select: { amount: true },
    });
    if (!lastCharge?.amount) continue;

    const next = convertUsdToLocal(amountUsd, Number(rate.rate), Number(tenant.roundingIncrement));
    if (!noticeRequired(Number(lastCharge.amount), next.amountLocal)) continue;

    // One notice per (subscription, rate) — the idempotency key IS the dedup.
    const dedupeKey = `fxnotice:${sub.id}:${rate.id}`;
    try {
      await prisma.billingEvent.create({
        data: {
          subscriptionId: sub.id,
          type: 'REMINDER',
          currencyCode: tenant.settlementCurrency,
          idempotencyKey: dedupeKey,
          note: `FX change notice: ${formatMoney(Number(lastCharge.amount), tenant.settlementCurrency)} → ${formatMoney(next.amountLocal, tenant.settlementCurrency)} @ ${Number(rate.rate)}`,
          amountUsd, fxRateId: rate.id, fxRateUsed: rate.rate,
        },
      });
    } catch {
      continue; // already noticed for this rate — dedup at the DB
    }

    const userId = sub.rider?.userId ?? sub.driver?.userId ?? sub.vendor?.owner.userId;
    if (!userId) continue;
    const from = new Date(sub.nextBillingDate).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
    await notifications.send({
      userId,
      type: 'SYSTEM_ANNOUNCEMENT',
      title: `Your weekly fee stays ${formatMoney(amountUsd, 'USD')}`,
      body: `The ${tenant.settlementCurrency} amount changes to ${formatMoney(next.amountLocal, tenant.settlementCurrency)} from ${from} (exchange-rate update).`,
      data: { kind: 'fx_change_notice', subscriptionId: sub.id, fxRateId: rate.id },
    }).catch(() => {});
    notified += 1;
  }

  if (notified > 0) log().info({ notified, rateId: rate.id }, 'fx change notices sent');
  return { notified };
}
