import type { PrismaClient } from '@prisma/client';
import type { Server } from 'socket.io';
import { NotificationService } from '../notification/notification.service';
import { convertUsdToLocal, formatMoney, resolveRateForRun } from './fx';
import { log } from '../../utils/logger';

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
      const current = Number(s.customRate ?? s.weeklyRate);
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

/** MODE B enable — freeze every existing payer on today's local price via
 *  customRate (the priceFor legacy branch), stamp the tenant sunset date. */
export async function enableModeB(prisma: PrismaClient, sunsetAt: Date): Promise<{ grandfathered: number }> {
  const subs = await prisma.subscription.findMany({
    where: { status: { in: ['ACTIVE', 'TRIAL', 'PAST_DUE'] }, customRate: null },
    select: { id: true, weeklyRate: true },
  });
  let grandfathered = 0;
  for (const s of subs) {
    await prisma.subscription.update({ where: { id: s.id }, data: { customRate: s.weeklyRate } });
    grandfathered += 1;
  }
  await prisma.tenantBillingCurrency.upsert({
    where: { tenantId: 'swift-default' },
    create: { tenantId: 'swift-default', usdMigrationMode: 'B', usdSunsetAt: sunsetAt },
    update: { usdMigrationMode: 'B', usdSunsetAt: sunsetAt },
  });
  log().info({ grandfathered, sunsetAt }, 'usd migration Mode B enabled — existing payers grandfathered');
  return { grandfathered };
}

/** MODE B daily sweep — T−30/T−7 notices recomputed from the sunset date and
 *  DB-deduped; past sunset, grandfathered rates clear (the book takes over)
 *  with a loud alert if either notice never went out. */
export async function sweepModeB(prisma: PrismaClient, io: Server, now = new Date()): Promise<{ notices: number; flipped: number; alerts: number }> {
  const tenant = await prisma.tenantBillingCurrency.findUnique({ where: { tenantId: 'swift-default' } });
  if (tenant?.usdMigrationMode !== 'B' || !tenant.usdSunsetAt) return { notices: 0, flipped: 0, alerts: 0 };
  const sunset = tenant.usdSunsetAt;
  const notifications = new NotificationService(prisma, io);
  const grandfathered = await prisma.subscription.findMany({
    where: { customRate: { not: null }, status: { in: ['ACTIVE', 'TRIAL', 'PAST_DUE', 'SUSPENDED'] } },
    select: { id: true, customRate: true },
  });
  let notices = 0;
  let flipped = 0;
  let alerts = 0;
  const currency = tenant.settlementCurrency;

  for (const s of grandfathered) {
    const phases: Array<{ key: string; dueFrom: number }> = [
      { key: 't30', dueFrom: sunset.getTime() - 30 * DAY_MS },
      { key: 't7', dueFrom: sunset.getTime() - 7 * DAY_MS },
    ];
    for (const phase of phases) {
      if (now.getTime() < phase.dueFrom) continue;
      try {
        await prisma.billingEvent.create({
          data: {
            subscriptionId: s.id, type: 'REMINDER', currencyCode: currency,
            idempotencyKey: `usdmigB:${s.id}:${phase.key}`,
            note: `Mode B sunset notice ${phase.key} (sunset ${sunset.toISOString().slice(0, 10)})`,
          },
        });
      } catch {
        continue; // this phase already sent
      }
      const userId = await userIdFor(prisma, s.id);
      if (userId) {
        const days = Math.max(1, Math.ceil((sunset.getTime() - now.getTime()) / DAY_MS));
        await notifications.send({
          userId, type: 'SYSTEM_ANNOUNCEMENT',
          title: 'Your weekly fee moves to USD pricing soon',
          body: `In ${days} day${days === 1 ? '' : 's'} your fee follows the USD price book. Your current ${formatMoney(Number(s.customRate), currency)} rate applies until then.`,
          data: { kind: 'usd_migration_notice', mode: 'B', phase: phase.key, subscriptionId: s.id },
        }).catch(() => {});
        notices += 1;
      }
    }

    if (now >= sunset) {
      // Verify both notices actually exist before flipping — missing → alert.
      const sent = await prisma.billingEvent.count({
        where: { subscriptionId: s.id, idempotencyKey: { in: [`usdmigB:${s.id}:t30`, `usdmigB:${s.id}:t7`] } },
      });
      if (sent < 2) {
        alerts += 1;
        log().error({ subscriptionId: s.id, sent }, 'usd migration Mode B: flipping past sunset with MISSING notices — investigate');
      }
      await prisma.subscription.update({ where: { id: s.id }, data: { customRate: null } });
      flipped += 1;
    }
  }
  if (notices + flipped > 0) log().info({ notices, flipped, alerts }, 'usd migration Mode B sweep');
  return { notices, flipped, alerts };
}
