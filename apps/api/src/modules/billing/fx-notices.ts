import type { PrismaClient } from '@prisma/client';
import type { Server } from 'socket.io';
import { NotificationService } from '../notification/notification.service';
import { convertUsdToLocal, noticeRequired, formatMoney, resolveRateForRun, resolveUpcomingRate, FX_NOTICE_WINDOW_DAYS } from './fx';
import { fxNoticesUndeliveredGauge, fxChargesWithoutNoticeGauge } from '../../plugins/observability';
import { log } from '../../utils/logger';

// System 2 Part 12 — the >2% notice rule: when a fee payer's NEXT local
// amount will differ >2% from their LAST charged amount (an FX move), they
// hear about it ≥7 days before the invoice, framed the only honest way:
// "Your weekly fee stays US$25.00 — the GY$ amount changes to GY$5,300 from
// {date} (exchange-rate update)." The price didn't change; the conversion did.
//
// [M-14] The notice is a CHARGE GATE, and the evidence follows delivery:
//   - the event is written first (deduped per subscription × rate at the DB),
//     the notification is sent second, and `deliveredAt` is stamped only when
//     the send succeeded. Before, the event was written and a failed send was
//     swallowed — the database said "noticed" while the payer heard nothing.
//   - an undelivered notice is re-attempted on every run; the charge gate in
//     billing counts a notice only once it is delivered, and only if it was
//     delivered FX_NOTICE_WINDOW_DAYS before the invoice.
//   - a rate the admin set to take effect in the future is announced NOW, so
//     its first invoice can be eligible; the current rate is announced too for
//     payers who have not yet heard.
//
// Runs as a daily job. Only meaningful when usdPricingEnabled; a no-op
// otherwise. Reads the SAME conversion function billing charges with — the
// notice can never disagree with the eventual charge.

const SUB_ROLE: Record<string, string> = {
  RESTAURANT: 'VENDOR', SUPERMARKET: 'VENDOR', RETAIL_STORE: 'VENDOR',
  SERVICE_PROVIDER: 'SERVICE', DELIVERY_RIDER: 'RIDER', COURIER_RIDER: 'RIDER', TAXI_DRIVER: 'DRIVER',
};
const DAY_MS = 86_400_000;

export const fxNoticeKey = (subscriptionId: string, rateId: string) => `fxnotice:${subscriptionId}:${rateId}`;

type PayerSub = {
  id: string; type: string; nextBillingDate: Date;
  rider: { userId: string } | null; driver: { userId: string } | null; vendor: { owner: { userId: string } } | null;
};

function payerOf(sub: PayerSub): string | undefined {
  return sub.rider?.userId ?? sub.driver?.userId ?? sub.vendor?.owner.userId;
}

/** The first invoice the announced amount can apply to: the payer's next
 *  bill, or the end of the notice window if that is later. */
function appliesFrom(sub: { nextBillingDate: Date }, now: Date): Date {
  const window = new Date(now.getTime() + FX_NOTICE_WINDOW_DAYS * DAY_MS);
  return sub.nextBillingDate.getTime() >= window.getTime() ? sub.nextBillingDate : window;
}

function noticeCopy(amountUsd: number, amountLocal: number, currency: string, from: Date) {
  return {
    title: `Your weekly fee stays ${formatMoney(amountUsd, 'USD')}`,
    body: `The ${currency} amount changes to ${formatMoney(amountLocal, currency)} from ${from.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })} (exchange-rate update).`,
  };
}

export async function runFxChangeNotices(
  prisma: PrismaClient,
  io: Server,
  now = new Date(),
  /** Injected context (the pinning suites' pattern): the tenant's pricing
   *  settings without reading the shared row, and a payer filter for a
   *  scoped re-run. Production passes nothing. */
  opts: { tenant?: { usdPricingEnabled: boolean; settlementCurrency: string; roundingIncrement: number }; subscriptionIds?: string[]; rateIds?: string[]; book?: Map<string, number> } = {},
): Promise<{ notified: number; delivered: number; undelivered: number; retried: number }> {
  const out = { notified: 0, delivered: 0, undelivered: 0, retried: 0 };
  const tenant = opts.tenant ?? await prisma.tenantBillingCurrency.findUnique({ where: { tenantId: 'swift-default' } });
  if (!tenant?.usdPricingEnabled) return out;
  const notifications = new NotificationService(prisma, io);
  const increment = Number(tenant.roundingIncrement);

  // 1. Re-attempt every notice whose payer has not been told yet. The event
  //    is the evidence of the obligation, not of its delivery.
  const owed = await prisma.billingEvent.findMany({
    where: { type: 'REMINDER', idempotencyKey: { startsWith: 'fxnotice:' }, deliveredAt: null, ...(opts.subscriptionIds ? { subscriptionId: { in: opts.subscriptionIds } } : {}) },
    orderBy: { createdAt: 'asc' },
    take: 200,
    include: { subscription: { include: { rider: { select: { userId: true } }, driver: { select: { userId: true } }, vendor: { select: { owner: { select: { userId: true } } } } } } },
  });
  for (const event of owed) {
    if (!event.amountUsd || !event.fxRateUsed) continue;
    const sub = event.subscription as unknown as PayerSub;
    const userId = payerOf(sub);
    if (!userId) continue;
    out.retried += 1;
    const local = convertUsdToLocal(Number(event.amountUsd), Number(event.fxRateUsed), increment).amountLocal;
    const delivered = await deliver(prisma, notifications, event.id, userId, sub.id, event.fxRateId ?? '', noticeCopy(Number(event.amountUsd), local, tenant.settlementCurrency, appliesFrom(sub, now)), now);
    if (delivered) out.delivered += 1;
  }

  // 2. Announce the rate in force AND the next one to take effect: a
  //    future-effective rate is told ahead of its first invoice.
  const rates = opts.rateIds
    ? await prisma.fxRate.findMany({ where: { id: { in: opts.rateIds } } }) // a scoped re-announcement
    : (await Promise.all([
      resolveRateForRun(prisma, tenant.settlementCurrency),
      resolveUpcomingRate(prisma, tenant.settlementCurrency, now),
    ])).filter((r): r is NonNullable<typeof r> => !!r);
  if (rates.length === 0) return finish(prisma, out, now, opts.subscriptionIds);
  const book = opts.book ?? new Map<string, number>();
  if (!opts.book) {
    const entries = await prisma.priceBookEntry.findMany({ where: { active: true } });
    for (const e of entries) book.set(`${e.role}|${e.tier ?? ''}`, Number(e.amountUsd));
  }
  const subs = await prisma.subscription.findMany({
    where: {
      autoRenew: true,
      customRate: null, // explicit local overrides are outside the USD book
      status: { in: ['ACTIVE', 'TRIAL', 'PAST_DUE'] },
      ...(opts.subscriptionIds ? { id: { in: opts.subscriptionIds } } : {}),
    },
    include: {
      rider: { select: { userId: true } },
      driver: { select: { userId: true } },
      vendor: { select: { owner: { select: { userId: true } } } },
    },
  });
  for (const rate of rates) {
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
      const next = convertUsdToLocal(amountUsd, Number(rate.rate), increment);
      if (!noticeRequired(Number(lastCharge.amount), next.amountLocal)) continue;
      // One notice per (subscription, rate) — the idempotency key IS the dedup.
      let eventId: string;
      try {
        const created = await prisma.billingEvent.create({
          data: {
            subscriptionId: sub.id,
            type: 'REMINDER',
            currencyCode: tenant.settlementCurrency,
            idempotencyKey: fxNoticeKey(sub.id, rate.id),
            note: `FX change notice: ${formatMoney(Number(lastCharge.amount), tenant.settlementCurrency)} → ${formatMoney(next.amountLocal, tenant.settlementCurrency)} @ ${Number(rate.rate)}`,
            amountUsd, fxRateId: rate.id, fxRateUsed: rate.rate,
          },
          select: { id: true },
        });
        eventId = created.id;
      } catch (err) {
        // Already noticed for this rate — dedup at the DB (delivery is step 1's
        // job). Anything else is a real failure and must not be mistaken for it.
        if ((err as { code?: string }).code === 'P2002') continue;
        throw err;
      }
      const userId = payerOf(sub as unknown as PayerSub);
      if (!userId) continue;
      out.notified += 1;
      const delivered = await deliver(prisma, notifications, eventId, userId, sub.id, rate.id, noticeCopy(amountUsd, next.amountLocal, tenant.settlementCurrency, appliesFrom(sub, now)), now);
      if (delivered) out.delivered += 1;
    }
  }
  return finish(prisma, out, now, opts.subscriptionIds);
}

/** Send, and only then write the delivery time. A failed send leaves the
 *  event undelivered for the next run — never a false "noticed". */
async function deliver(
  prisma: PrismaClient,
  notifications: NotificationService,
  eventId: string,
  userId: string,
  subscriptionId: string,
  fxRateId: string,
  copy: { title: string; body: string },
  now: Date,
): Promise<boolean> {
  try {
    await notifications.send({
      userId,
      type: 'SYSTEM_ANNOUNCEMENT',
      title: copy.title,
      body: copy.body,
      data: { kind: 'fx_change_notice', subscriptionId, fxRateId },
    });
  } catch (err) {
    log().warn({ err, eventId, subscriptionId }, '[M-14] fx change notice not delivered — the charge gate holds the previous rate until it is');
    return false;
  }
  await prisma.billingEvent.update({ where: { id: eventId }, data: { deliveredAt: now } });
  return true;
}

async function finish(prisma: PrismaClient, out: { notified: number; delivered: number; undelivered: number; retried: number }, now: Date, subscriptionIds?: string[]) {
  const undelivered = await prisma.billingEvent.findMany({
    where: { type: 'REMINDER', idempotencyKey: { startsWith: 'fxnotice:' }, deliveredAt: null, ...(subscriptionIds ? { subscriptionId: { in: subscriptionIds } } : {}) },
    orderBy: { createdAt: 'asc' },
    select: { createdAt: true },
  });
  out.undelivered = undelivered.length;
  fxNoticesUndeliveredGauge.labels('count').set(undelivered.length);
  fxNoticesUndeliveredGauge.labels('oldest_hours').set(undelivered[0] ? Math.max(0, Math.round((now.getTime() - undelivered[0].createdAt.getTime()) / 3_600_000)) : 0);
  if (out.notified > 0 || out.retried > 0) log().info(out, 'fx change notices');
  return out;
}

/** [M-14 · operations] Charges that used a rate the payer had not been told
 *  about in time: a successful charge whose pinned rate differs from the
 *  previous charge's, whose amount moved by more than the notice rule's 2%,
 *  and for which no notice was delivered at least the window before the
 *  invoice. Found for a remediation review — never altered here. */
export async function scanChargesWithoutDeliveredNotice(prisma: PrismaClient, opts: { sinceDays?: number } = {}): Promise<Array<{ subscriptionId: string; eventId: string; fxRateId: string; amount: number; previousAmount: number }>> {
  const since = new Date(Date.now() - (opts.sinceDays ?? 30) * DAY_MS);
  const charges = await prisma.billingEvent.findMany({
    where: { type: 'CHARGE_SUCCESS', createdAt: { gte: since }, fxRateId: { not: null }, amount: { not: null } },
    orderBy: [{ subscriptionId: 'asc' }, { createdAt: 'asc' }],
    select: { id: true, subscriptionId: true, fxRateId: true, amount: true, createdAt: true },
  });
  const found: Array<{ subscriptionId: string; eventId: string; fxRateId: string; amount: number; previousAmount: number }> = [];
  for (const charge of charges) {
    const previous = await prisma.billingEvent.findFirst({
      where: { subscriptionId: charge.subscriptionId, type: 'CHARGE_SUCCESS', amount: { not: null }, createdAt: { lt: charge.createdAt } },
      orderBy: { createdAt: 'desc' },
      select: { fxRateId: true, amount: true },
    });
    if (!previous?.amount || previous.fxRateId === charge.fxRateId) continue;
    if (!noticeRequired(Number(previous.amount), Number(charge.amount!))) continue;
    const notice = await prisma.billingEvent.findUnique({ where: { idempotencyKey: fxNoticeKey(charge.subscriptionId, charge.fxRateId!) }, select: { deliveredAt: true } });
    const deadline = charge.createdAt.getTime() - FX_NOTICE_WINDOW_DAYS * DAY_MS;
    if (notice?.deliveredAt && notice.deliveredAt.getTime() <= deadline) continue;
    found.push({ subscriptionId: charge.subscriptionId, eventId: charge.id, fxRateId: charge.fxRateId!, amount: Number(charge.amount), previousAmount: Number(previous.amount) });
  }
  fxChargesWithoutNoticeGauge.set(found.length);
  if (found.length > 0) log().error({ count: found.length, sample: found.slice(0, 10) }, '[M-14] charges at a rate the payer was not told about in time — open a remediation review');
  return found;
}
