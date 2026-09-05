import type { OnAudit } from '../../lib/audit-writer';
import type { PrismaClient } from '@prisma/client';
import type { Server } from 'socket.io';
import { NotificationService, notifyAdmins } from '../notification/notification.service';
import { convertUsdToLocal, formatMoney, resolveRateForRun } from './fx';
import { log } from '../../utils/logger';
import { usdMigrationFlipsCounter, usdMigrationHeldGauge } from '../../plugins/observability';
import { weeklyFeeAmount } from './subscription-fee';

// System 2 Part 13/20 — migration of existing local-priced subscriptions.
// The founder picks a mode per tenant at enable time:
//
// MODE A (convert): every sub maps to the nearest USD book entry. preview()
// is the mapping table the founder approves; enact() sends the 30-day notice
// (DB-deduped) — pricing itself flips when usdPricingEnabled turns on, and
// priceFor takes over automatically. Issued charges are never touched.
//
// MODE B (grandfather): existing actors FREEZE on today's local price via the
// EXISTING customRate mechanism (priceFor's customRate branch keeps legacy —
// zero new billing logic), while new signups get the USD book. A tenant-wide
// sunset date drives T−30 and T−7 notices — guaranteed by DATA, not by a cron
// remembering: the daily job recomputes who owes which notice from the sunset
// date every run and the DB dedup key makes sends once-only. Past sunset, the
// job clears customRate (the book takes over) and verifies both notices went
// out (missing → loud alert, never silent).

const SUB_ROLE: Record<string, string> = {
  RESTAURANT: 'VENDOR', SUPERMARKET: 'VENDOR', RETAIL_STORE: 'VENDOR',
  SERVICE_PROVIDER: 'SERVICE', DELIVERY_RIDER: 'RIDER', COURIER_RIDER: 'RIDER', TAXI_DRIVER: 'DRIVER',
};
const DAY_MS = 86_400_000;

async function userIdFor(prisma: PrismaClient, subId: string): Promise<string | null> {
  const sub = await prisma.subscription.findUnique({
    where: { id: subId },
    select: {
      rider: { select: { userId: true } },
      driver: { select: { userId: true } },
      vendor: { select: { owner: { select: { userId: true } } } },
    },
  });
  return sub?.rider?.userId ?? sub?.driver?.userId ?? sub?.vendor?.owner.userId ?? null;
}

/** MODE A preview — the founder's approval table: every active sub, its
 *  current local price, the mapped USD entry, and the new local amount at the
 *  current rate. Pure read. */
export async function previewModeA(prisma: PrismaClient) {
  const tenant = await prisma.tenantBillingCurrency.findUnique({ where: { tenantId: 'swift-default' } });
  const currency = tenant?.settlementCurrency ?? 'GYD';
  const increment = Number(tenant?.roundingIncrement ?? 100);
  const rate = await resolveRateForRun(prisma, currency);
  if (!rate) return { error: 'NO_FX_RATE', rows: [] as unknown[] };

  const entries = await prisma.priceBookEntry.findMany({ where: { active: true } });
  const book = new Map<string, number>();
  for (const e of entries) book.set(`${e.role}|${e.tier ?? ''}`, Number(e.amountUsd));

  const subs = await prisma.subscription.findMany({
    where: { status: { in: ['ACTIVE', 'TRIAL', 'PAST_DUE'] } },
    select: { id: true, type: true, weeklyRate: true, customRate: true },
  });
  return {
    rateId: rate.id,
    rate: Number(rate.rate),
    rows: subs.map((s) => {
      const role = SUB_ROLE[s.type] ?? 'VENDOR';
      const amountUsd = book.get(`${role}|${s.type}`) ?? book.get(`${role}|`);
      const current = weeklyFeeAmount(s);
      const next = amountUsd !== undefined ? convertUsdToLocal(amountUsd, Number(rate.rate), increment).amountLocal : null;
      return {
        subscriptionId: s.id, type: s.type,
        currentLocal: current, mappedUsd: amountUsd ?? null, nextLocal: next,
        deltaPct: next !== null && current > 0 ? Math.round(((next - current) / current) * 10000) / 100 : null,
        unmapped: amountUsd === undefined,
      };
    }),
  };
}

/** MODE A enact — send the 30-day notice to every affected payer (deduped);
 *  the founder flips usdPricingEnabled when the window has run. */
export async function enactModeA(prisma: PrismaClient, io: Server): Promise<{ noticed: number; unmapped: number }> {
  const preview = await previewModeA(prisma);
  if ('error' in preview && preview.error) return { noticed: 0, unmapped: 0 };
  const notifications = new NotificationService(prisma, io);
  let noticed = 0;
  let unmapped = 0;
  const tenant = await prisma.tenantBillingCurrency.findUnique({ where: { tenantId: 'swift-default' } });
  const currency = tenant?.settlementCurrency ?? 'GYD';
  for (const row of preview.rows as Array<{ subscriptionId: string; currentLocal: number; mappedUsd: number | null; nextLocal: number | null; unmapped: boolean }>) {
    if (row.unmapped || row.nextLocal === null || row.mappedUsd === null) {
      unmapped += 1;
      continue;
    }
    try {
      await prisma.billingEvent.create({
        data: {
          subscriptionId: row.subscriptionId, type: 'REMINDER', currencyCode: currency,
          idempotencyKey: `usdmigA:${row.subscriptionId}`,
          note: `Mode A 30-day notice: ${formatMoney(row.currentLocal, currency)} → ${formatMoney(row.nextLocal, currency)} (US$${row.mappedUsd}/wk)`,
        },
      });
    } catch {
      continue; // already noticed
    }
    const userId = await userIdFor(prisma, row.subscriptionId);
    if (userId) {
      await notifications.send({
        userId, type: 'SYSTEM_ANNOUNCEMENT',
        title: 'Your weekly fee is moving to USD pricing',
        body: `From 30 days from today your fee is ${formatMoney(row.mappedUsd, 'USD')}/week (${formatMoney(row.nextLocal, currency)} at today's rate). Issued invoices never change.`,
        data: { kind: 'usd_migration_notice', mode: 'A', subscriptionId: row.subscriptionId },
      }).catch(() => {});
      noticed += 1;
    }
  }
  return { noticed, unmapped };
}

/** [M-15] A subscription belongs to the tenant of the vendor, rider or driver
 *  that holds it. The migration's every read and write is scoped by this. */
export const subscriptionTenantWhere = (tenantId: string) => ({
  OR: [
    { vendor: { tenantId }, riderId: null, driverId: null },
    { rider: { user: { tenantId } }, vendorId: null, driverId: null },
    { driver: { user: { tenantId } }, vendorId: null, riderId: null },
  ],
});

export const modeBKey = (subscriptionId: string, phase: 't30' | 't7' | 'freeze' | 'flip') => `usdmigB:${subscriptionId}:${phase}`;

/** MODE B enable — freeze every existing payer OF THIS TENANT on today's
 *  local price via customRate (the priceFor legacy branch), record the
 *  immutable price assignment per payer, stamp the tenant's sunset date.
 *  [M-15] Before, this selected and froze every tenant's payers while the
 *  control row was hardcoded to swift-default. */
export async function enableModeB(prisma: PrismaClient, sunsetAt: Date, tenantId = 'swift-default', onAudit?: OnAudit): Promise<{ grandfathered: number; tenantId: string }> {
  const subs = await prisma.subscription.findMany({
    where: { status: { in: ['ACTIVE', 'TRIAL', 'PAST_DUE'] }, customRate: null, ...subscriptionTenantWhere(tenantId) },
    select: { id: true, weeklyRate: true, currencyCode: true },
  });
  let grandfathered = 0;
  for (const s of subs) {
    await prisma.$transaction(async (tx) => {
      await tx.subscription.update({ where: { id: s.id }, data: { customRate: s.weeklyRate } });
      // The immutable assignment: what this payer was pinned at, and when.
      // [M-15] `skipDuplicates`, not a swallowed P2002: inside an interactive
      // transaction a unique violation ABORTS the transaction in Postgres, and
      // every later statement fails with 25P02 — a payer re-frozen after a
      // rollback could never be processed again.
      await tx.billingEvent.createMany({
        data: [{
          subscriptionId: s.id, type: 'TIER_CHANGE', amount: s.weeklyRate, currencyCode: s.currencyCode,
          idempotencyKey: modeBKey(s.id, 'freeze'),
          note: `Mode B grandfathered at ${formatMoney(Number(s.weeklyRate), s.currencyCode)} (tenant ${tenantId}, sunset ${sunsetAt.toISOString().slice(0, 10)})`,
        }],
        skipDuplicates: true,
      });
    });
    grandfathered += 1;
  }
  // [ADM-002] The mode flip is the consequential switch; its audit row commits
  // with it. The per-payer freezes above are idempotent rows that precede it.
  await prisma.$transaction(async (tx) => {
    await tx.tenantBillingCurrency.upsert({
      where: { tenantId },
      create: { tenantId, usdMigrationMode: 'B', usdSunsetAt: sunsetAt },
      update: { usdMigrationMode: 'B', usdSunsetAt: sunsetAt },
    });
    await onAudit?.(tx, { mode: 'B', grandfathered, sunsetAt: sunsetAt.toISOString(), tenantId });
  });
  log().info({ grandfathered, sunsetAt, tenantId }, 'usd migration Mode B enabled — existing payers grandfathered');
  return { grandfathered, tenantId };
}

/** MODE B daily sweep — per tenant in Mode B: T−30/T−7 notices recomputed
 *  from the sunset date, DB-deduped, with delivery PROOF (the event is the
 *  obligation; `deliveredAt` is stamped only after the send succeeded, and an
 *  undelivered notice is re-attempted every sweep). Past sunset a payer flips
 *  to the USD book ONLY when both notices are verifiably delivered — otherwise
 *  they stay pinned, are counted, and the tenant's operators are paged.
 *  [M-15] Before: every tenant's payers were selected and flipped from the
 *  default tenant's control row; a failed send was swallowed after the event
 *  was written; and a payer with missing notices was flipped anyway with a
 *  log line. Every flip records the immutable snapshot rollback points to. */
export async function sweepModeB(
  prisma: PrismaClient,
  io: Server,
  now = new Date(),
  opts: { tenantIds?: string[] } = {},
): Promise<{ notices: number; delivered: number; undelivered: number; flipped: number; held: number; alerts: number; tenants: number }> {
  const out = { notices: 0, delivered: 0, undelivered: 0, flipped: 0, held: 0, alerts: 0, tenants: 0 };
  const tenants = await prisma.tenantBillingCurrency.findMany({
    where: { usdMigrationMode: 'B', usdSunsetAt: { not: null }, ...(opts.tenantIds ? { tenantId: { in: opts.tenantIds } } : {}) },
  });
  const notifications = new NotificationService(prisma, io);
  for (const tenant of tenants) {
    const sunset = tenant.usdSunsetAt!;
    const currency = tenant.settlementCurrency;
    out.tenants += 1;
    const grandfathered = await prisma.subscription.findMany({
      where: { customRate: { not: null }, status: { in: ['ACTIVE', 'TRIAL', 'PAST_DUE', 'SUSPENDED'] }, ...subscriptionTenantWhere(tenant.tenantId) },
      select: { id: true, customRate: true, currencyCode: true },
    });
    let heldHere = 0;
    for (const s of grandfathered) {
      const phases: Array<{ key: 't30' | 't7'; dueFrom: number }> = [
        { key: 't30', dueFrom: sunset.getTime() - 30 * DAY_MS },
        { key: 't7', dueFrom: sunset.getTime() - 7 * DAY_MS },
      ];
      for (const phase of phases) {
        if (now.getTime() < phase.dueFrom) continue;
        const key = modeBKey(s.id, phase.key);
        let event = await prisma.billingEvent.findUnique({ where: { idempotencyKey: key }, select: { id: true, deliveredAt: true } });
        if (!event) {
          try {
            event = await prisma.billingEvent.create({
              data: {
                subscriptionId: s.id, type: 'REMINDER', currencyCode: currency,
                idempotencyKey: key,
                note: `Mode B sunset notice ${phase.key} (sunset ${sunset.toISOString().slice(0, 10)})`,
              },
              select: { id: true, deliveredAt: true },
            });
            out.notices += 1;
          } catch (err) {
            if ((err as { code?: string }).code !== 'P2002') throw err;
            event = await prisma.billingEvent.findUniqueOrThrow({ where: { idempotencyKey: key }, select: { id: true, deliveredAt: true } });
          }
        }
        if (event.deliveredAt) continue; // told already
        const userId = await userIdFor(prisma, s.id);
        if (!userId) continue;
        const days = Math.max(1, Math.ceil((sunset.getTime() - now.getTime()) / DAY_MS));
        try {
          await notifications.send({
            userId, type: 'SYSTEM_ANNOUNCEMENT',
            title: 'Your weekly fee moves to USD pricing soon',
            body: `In ${days} day${days === 1 ? '' : 's'} your fee follows the USD price book. Your current ${formatMoney(Number(s.customRate), currency)} rate applies until then.`,
            data: { kind: 'usd_migration_notice', mode: 'B', phase: phase.key, subscriptionId: s.id },
          });
          await prisma.billingEvent.update({ where: { id: event.id }, data: { deliveredAt: now } });
          out.delivered += 1;
        } catch (err) {
          out.undelivered += 1;
          log().warn({ err, subscriptionId: s.id, phase: phase.key }, '[M-15] Mode B notice not delivered — the payer stays pinned until it is');
        }
      }

      if (now >= sunset) {
        // The hard gate: both notices verifiably DELIVERED — and the T−7 one
        // delivered at least seven days ago, so a notice that only got through
        // late still gives its week of warning — or the payer stays pinned at
        // the price they were promised.
        const proofs = await prisma.billingEvent.count({
          where: {
            subscriptionId: s.id,
            OR: [
              { idempotencyKey: modeBKey(s.id, 't30'), deliveredAt: { not: null } },
              { idempotencyKey: modeBKey(s.id, 't7'), deliveredAt: { lte: new Date(now.getTime() - 7 * DAY_MS) } },
            ],
          },
        });
        if (proofs < 2) {
          heldHere += 1;
          log().error({ subscriptionId: s.id, proofs, tenantId: tenant.tenantId }, '[M-15] Mode B past sunset with notice proof missing — payer HELD at the grandfathered rate');
          continue;
        }
        await prisma.$transaction(async (tx) => {
          // The immutable snapshot rollback points to: the pinned price, now released.
          try {
            // [M-15] `skipDuplicates`: a payer flipped, rolled back and flipped
            // again already has this row; a swallowed P2002 here aborted the
            // transaction and the `customRate: null` below failed with 25P02.
            await tx.billingEvent.createMany({
              data: [{
                subscriptionId: s.id, type: 'TIER_CHANGE', amount: s.customRate!, currencyCode: s.currencyCode,
                idempotencyKey: modeBKey(s.id, 'flip'),
                note: `Mode B sunset: ${formatMoney(Number(s.customRate), currency)} released to the USD price book (tenant ${tenant.tenantId})`,
              }],
              skipDuplicates: true,
            });
          } catch (err) {
            if ((err as { code?: string }).code !== 'P2002') throw err;
          }
          await tx.subscription.update({ where: { id: s.id }, data: { customRate: null } });
        });
        out.flipped += 1;
        usdMigrationFlipsCounter.labels('flipped').inc();
      }
    }
    if (heldHere > 0) {
      out.held += heldHere;
      out.alerts += 1;
      await notifyAdmins(prisma, notifications, {
        tenantId: tenant.tenantId,
        title: '💱 USD migration: payers held at their old rate — notice proof missing',
        body: `${heldHere} grandfathered payer(s) passed the sunset without both T−30 and T−7 notices verifiably delivered. They stay pinned at the rate they were promised until the notices are delivered; nothing was flipped for them.`,
        data: { kind: 'billing_invariants', alert: 'usd-migration-notice-proof', held: heldHere },
      }).catch(() => {});
    }
  }
  usdMigrationHeldGauge.set(out.held);
  if (out.notices + out.flipped + out.held > 0) log().info(out, 'usd migration Mode B sweep');
  return out;
}

/** [M-15] Rollback is a pointer back to the immutable snapshot, never a
 *  rewrite: every payer of THIS tenant who was released at sunset is pinned
 *  again at the exact price the flip event recorded, and the return trip is
 *  itself recorded. The tenant leaves Mode B. */
export async function rollbackModeB(prisma: PrismaClient, tenantId: string, now = new Date(), onAudit?: OnAudit): Promise<{ restored: number; tenantId: string }> {
  const flips = await prisma.billingEvent.findMany({
    where: { idempotencyKey: { startsWith: 'usdmigB:' }, type: 'TIER_CHANGE', note: { startsWith: 'Mode B sunset:' }, subscription: { ...subscriptionTenantWhere(tenantId), customRate: null } },
    select: { id: true, subscriptionId: true, amount: true, currencyCode: true },
  });
  let restored = 0;
  for (const flip of flips) {
    if (flip.amount == null) continue;
    await prisma.$transaction(async (tx) => {
      await tx.subscription.update({ where: { id: flip.subscriptionId }, data: { customRate: flip.amount! } });
      await tx.billingEvent.create({
        data: {
          subscriptionId: flip.subscriptionId, type: 'TIER_CHANGE', amount: flip.amount!, currencyCode: flip.currencyCode,
          idempotencyKey: `usdmigB:${flip.subscriptionId}:rollback:${now.getTime()}`,
          note: `Mode B rollback: pinned again at ${formatMoney(Number(flip.amount), flip.currencyCode)} from the sunset snapshot (tenant ${tenantId})`,
        },
      });
    });
    restored += 1;
    usdMigrationFlipsCounter.labels('rolled_back').inc();
  }
  await prisma.$transaction(async (tx) => {
    await tx.tenantBillingCurrency.updateMany({ where: { tenantId }, data: { usdMigrationMode: null, usdSunsetAt: null } });
    await onAudit?.(tx, { rollback: true, restored, tenantId });
  });
  log().warn({ restored, tenantId }, '[M-15] usd migration Mode B rolled back — payers pinned again from their snapshots');
  return { restored, tenantId };
}
