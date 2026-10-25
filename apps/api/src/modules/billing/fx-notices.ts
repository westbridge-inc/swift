import type { PrismaClient } from '@prisma/client';
import type { Server } from 'socket.io';
import { NotificationService } from '../notification/notification.service';
import { convertUsdToLocal, noticeRequired, formatMoney, resolveRateForRun, resolveUpcomingRate, FX_NOTICE_WINDOW_DAYS } from './fx';
import { fxNoticesUndeliveredGauge, fxChargesWithoutNoticeGauge } from '../../plugins/observability';
import { log } from '../../utils/logger';
import { lockFeeCollectionAuthority, readFeeCollectionAuthority } from '../subscription/mover-fee-authority';
import { activePriceBook, bookAt, bookRowsAt, earliestPriceChange, priceBookKey, priceBookNoticeKey, PRICE_BOOK_NOTICE_DAYS } from './price-book';

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

  // [F2 · GUARDRAILS §7] Every scheduled price-book change is announced to every
  // partner it changes (a partner who joined since, or whose notice failed, is
  // told now; the charge gate counts the notice only from its delivery).
  if (!opts.subscriptionIds) {
    // Scheduled rows, lower ones that started in the last week (told as well), and
    // rows in force now (a notice not yet delivered is retried; REVIEW-G S2-1).
    const book = await activePriceBook(prisma);
    const inForce = new Set([...bookRowsAt(book, now).values()].map((row) => row.id));
    const upcoming = book.filter((row) => row.effectiveFrom.getTime() > now.getTime() - 7 * DAY_MS || inForce.has(row.id));
    for (const row of upcoming) await announcePriceBookEntry(prisma, io, row.id, now);
  }

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
    const authority = await readFeeCollectionAuthority(prisma, sub.id);
    if (!authority.canonical) continue;
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
  // [F2] The book in force now (a scheduled price is announced by announcePriceBookEntry).
  const book = opts.book ?? bookAt(await activePriceBook(prisma), now);
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
      const authority = await readFeeCollectionAuthority(prisma, sub.id);
      if (!authority.canonical) continue;
      const feeType = authority.mover?.feeType ?? sub.type;
      const role = SUB_ROLE[feeType] ?? 'VENDOR';
      const amountUsd = book.get(`${role}|${feeType}`) ?? book.get(`${role}|`);
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
        const created = await prisma.$transaction(async (tx) => {
          const current = await lockFeeCollectionAuthority(tx, sub.id);
          // Neutral price disclosure remains allowed during a finance hold.
          // An alias or changed tariff waits for a new canonical projection.
          if (current.mover && (current.mover.canonicalSubscriptionId !== sub.id || current.mover.feeType !== feeType)) return null;
          return tx.billingEvent.create({
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
        });
        if (!created) continue;
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

/** The first weekly fee date on or after `earliest`. */
function firstFeeOnOrAfter(nextBillingDate: Date, earliest: Date): Date {
  const next = nextBillingDate.getTime();
  if (next >= earliest.getTime()) return new Date(next);
  return new Date(next + Math.ceil((earliest.getTime() - next) / (7 * DAY_MS)) * 7 * DAY_MS);
}

/**
 * [Owner legal plan · F2 · GUARDRAILS §7] Tell every partner a scheduled
 * price-book row changes: the new amount (and today's local estimate) and the
 * first weekly fee it applies to, which is the first fee date on or after
 * both its effectiveFrom and 14 days from this notice (the charge gate in
 * billing applies the same rule). One notice per (subscription, row): the
 * event is written first, the notice sent second, and deliveredAt stamped only
 * once it was sent. A no-op while USD pricing is off (no fee comes from the
 * book), or for a row already in force.
 */
export async function announcePriceBookEntry(prisma: PrismaClient, io: Server, entryId: string, now = new Date()): Promise<{ notified: number; delivered: number }> {
  const out = { notified: 0, delivered: 0 };
  const tenant = await prisma.tenantBillingCurrency.findUnique({ where: { tenantId: 'swift-default' } });
  if (!tenant?.usdPricingEnabled) return out;
  const entry = await prisma.priceBookEntry.findUnique({ where: { id: entryId } });
  if (!entry || !entry.active) return out;
  const rows = await activePriceBook(prisma);
  const amountUsd = Number(entry.amountUsd);
  // [coordinator ruling 15 Oct] A LOWER price may start the next billing week (no
  // 14-day wait) and is still told; it is told for a week after it starts too.
  const previous = bookRowsAt(rows, new Date(entry.effectiveFrom.getTime() - 1)).get(priceBookKey(entry.role, entry.tier));
  const lower = !!previous && amountUsd < previous.amountUsd;
  // [REVIEW-G S2-1] Once a HIGHER price is in force, a notice not yet delivered is
  // still retried while it is the price in force (the charge keeps the price last
  // paid until 14 days after it is); nobody new is told then.
  const started = entry.effectiveFrom.getTime() <= now.getTime();
  const retryOnly = started && !lower && bookRowsAt(rows, now).get(priceBookKey(entry.role, entry.tier))?.id === entry.id;
  if (started && !retryOnly && !(lower && entry.effectiveFrom.getTime() > now.getTime() - 7 * DAY_MS)) return out;
  // Retry-only: just the partners whose notice of this row was written but not delivered.
  const pending = retryOnly
    ? (await prisma.billingEvent.findMany({ where: { idempotencyKey: { startsWith: 'pricebook-notice:', endsWith: `:${entry.id}` }, deliveredAt: null }, select: { subscriptionId: true } })).map((e) => e.subscriptionId)
    : null;
  if (pending && pending.length === 0) return out;
  const rate = await resolveRateForRun(prisma, tenant.settlementCurrency);
  const notifications = new NotificationService(prisma, io);
  const types = Object.entries(SUB_ROLE).filter(([, role]) => role === entry.role).map(([type]) => type);
  const subs = await prisma.subscription.findMany({
    where: {
      autoRenew: true, customRate: null, status: { in: ['ACTIVE', 'TRIAL', 'PAST_DUE'] },
      ...(pending ? { id: { in: pending } } : {}),
      type: { in: (entry.tier ? types.filter((t) => t === entry.tier) : types) as never },
    },
    include: { rider: { select: { userId: true } }, driver: { select: { userId: true } }, vendor: { select: { owner: { select: { userId: true } } } } },
  });
  for (const sub of subs) {
    // A role-wide row does not change a type that has its own tier row.
    if (!entry.tier && rows.some((r) => r.role === entry.role && r.tier === sub.type)) continue;
    const authority = await readFeeCollectionAuthority(prisma, sub.id);
    if (!authority.canonical) continue;
    const userId = payerOf(sub as unknown as PayerSub);
    if (!userId) continue;
    const key = priceBookNoticeKey(sub.id, entry.id);
    const existing = await prisma.billingEvent.findUnique({ where: { idempotencyKey: key }, select: { id: true, deliveredAt: true } });
    if (existing?.deliveredAt || (retryOnly && !existing)) continue;
    const local = rate ? convertUsdToLocal(amountUsd, Number(rate.rate), Number(tenant.roundingIncrement)).amountLocal : null;
    let eventId = existing?.id;
    if (!eventId) {
      try {
        eventId = (await prisma.billingEvent.create({
          data: {
            subscriptionId: sub.id, type: 'REMINDER', currencyCode: tenant.settlementCurrency, idempotencyKey: key, amountUsd,
            note: `Price change notice: US$${amountUsd} from ${entry.effectiveFrom.toISOString()} (price-book row ${entry.id})`,
          },
          select: { id: true },
        })).id;
      } catch (err) {
        if ((err as { code?: string }).code === 'P2002') continue;
        throw err;
      }
      out.notified += 1;
    }
    const appliesFrom = firstFeeOnOrAfter(sub.nextBillingDate, new Date(Math.max(entry.effectiveFrom.getTime(), lower ? now.getTime() : earliestPriceChange(now).getTime())));
    const day = appliesFrom.toLocaleDateString('en-GB', { timeZone: 'America/Guyana', weekday: 'long', day: 'numeric', month: 'long' });
    let inboxId = '';
    try {
      inboxId = await notifications.send({
        userId, type: 'SYSTEM_ANNOUNCEMENT', audience: sub.vendor ? 'business' : 'earner',
        title: lower ? 'Your weekly fee is going down' : 'Your weekly fee is changing',
        body: `From your weekly fee due ${day}, your Swift weekly fee will be ${formatMoney(amountUsd, 'USD')}${local !== null ? ` (about ${formatMoney(local, tenant.settlementCurrency)} at today's exchange rate)` : ''}. ${lower ? 'A week you have already paid keeps the price you paid.' : 'Until then nothing changes, and any week you have already paid keeps the price you paid.'}`,
        data: { kind: 'billing_rate_change', change: 'PRICE_BOOK', subscriptionId: sub.id, priceBookEntryId: entry.id, amountUsd, appliesFrom: appliesFrom.toISOString() },
        dedupeKey: key,
      });
    } catch (err) {
      log().warn({ err, subscriptionId: sub.id, entryId }, '[F2] price-book change notice not delivered — the charge gate keeps the price before it until it is');
    }
    // An inbox row is the notice; without one nothing counts as told (the next run retries).
    if (!inboxId) continue;
    await prisma.billingEvent.update({ where: { id: eventId }, data: { deliveredAt: now } });
    out.delivered += 1;
  }
  if (out.notified > 0) log().info({ entryId, ...out, noticeDays: PRICE_BOOK_NOTICE_DAYS }, '[F2] price-book change notices');
  return out;
}

