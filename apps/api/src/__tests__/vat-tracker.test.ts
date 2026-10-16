import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import type { BillingEventType, SubscriptionStatus, UserRole } from '@prisma/client';
import { prismaPlugin } from '../plugins/prisma';
import { runWithoutTenant } from '../plugins/tenant-context';
import { syntheticLocationOwner } from './helpers/online-mover';
import { cleanupBillingClocks } from './helpers/billing-clock-cleanup';
import { VAT_APPLY_WITHIN_DAYS, VAT_EARLY_ALERT_GYD, VAT_REGISTRATION_THRESHOLD_GYD, vatAlert, vatTracker, type VatTracker } from '../modules/billing/vat-tracker';

// ---------------------------------------------------------------------------
// [OWNER LEGAL PLAN 15 Oct 2026 · R10, research T1] The VAT registration
// tracker: weekly fees due and received per Guyana month, the year ahead from
// today's partners (free-trial weeks nil), and an admin alert at GYD
// 10,000,000 over the last 12 months or when the year ahead is expected to
// reach the GYD 15,000,000 threshold, naming the 15-day deadline.
// Each case runs in a tenant of its own, so other suites' fees never count.
// ---------------------------------------------------------------------------

const DAY = 24 * 60 * 60 * 1000;
// This file's own fixture block (+5920337nnn). No other file uses 5920337.
const PHONE_PREFIX = '+5920337';
const NOW = new Date('2026-10-20T16:00:00Z'); // a Tuesday afternoon in Guyana, October 2026

let app: FastifyInstance;
let seq = 0;
const tenants: string[] = [];

const sys = <T>(fn: () => Promise<T>) => runWithoutTenant(fn);

async function newTenant() {
  const id = `vat-tracker-${nanoid(8).toLowerCase()}`;
  await sys(() => app.prisma.tenant.create({ data: { id, name: 'VAT tracker tenant', slug: id, isActive: true } }));
  tenants.push(id);
  return id;
}

async function rider(tenantId: string, opts: { weeklyRate?: number; customRate?: number; status?: SubscriptionStatus; trialEndDate?: Date } = {}) {
  seq += 1;
  const user = await sys(() => app.prisma.user.create({ data: {
    phone: `${PHONE_PREFIX}${String(seq).padStart(3, '0')}`, firstName: 'Vat', lastName: `Rider${seq}`,
    roles: ['MOVER', 'CUSTOMER'] as UserRole[], activeRole: 'MOVER', isPhoneVerified: true, tenantId,
  } }));
  const r = await sys(() => app.prisma.rider.create({ data: { userId: user.id, riderType: 'DELIVERY', vehicleType: 'MOTORCYCLE', documentsVerified: true, isOnline: false, locationSessionId: syntheticLocationOwner('vat-tracker') } }));
  const due = new Date(NOW.getTime() + 3 * DAY);
  const trial = opts.status === 'TRIAL';
  const sub = await sys(() => app.prisma.subscription.create({ data: {
    riderId: r.id, type: 'DELIVERY_RIDER', status: opts.status ?? 'ACTIVE', weeklyRate: opts.weeklyRate ?? 6000,
    ...(opts.customRate !== undefined ? { customRate: opts.customRate } : {}),
    billingMethod: 'CASH', autoRenew: true, currentPeriodStart: new Date(due.getTime() - 7 * DAY), currentPeriodEnd: due, nextBillingDate: due,
    ...(trial ? { isTrialActive: true, trialEndDate: opts.trialEndDate } : {}),
  } }));
  return sub.id;
}

async function event(subscriptionId: string, type: BillingEventType, amount: number, at: string, key: string, paymentRef?: string) {
  await sys(() => app.prisma.billingEvent.create({ data: {
    subscriptionId, type, amount, currencyCode: 'GYD', idempotencyKey: `${key}`, createdAt: new Date(at), ...(paymentRef ? { paymentRef } : {}),
  } }));
}

beforeAll(async () => {
  process.env['NODE_ENV'] = 'development';
  process.env['DATABASE_URL'] = process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift';
  app = Fastify({ logger: false });
  await app.register(prismaPlugin);
  await app.ready();
});

afterAll(async () => {
  await sys(async () => {
    const users = await app.prisma.user.findMany({ where: { tenantId: { in: tenants } }, select: { id: true } });
    const ids = users.map((u) => u.id);
    const subs = await app.prisma.subscription.findMany({ where: { rider: { userId: { in: ids } } }, select: { id: true } });
    const sids = subs.map((s) => s.id);
    await cleanupBillingClocks(app.prisma, sids);
    await app.prisma.billingEvent.deleteMany({ where: { subscriptionId: { in: sids } } });
    await app.prisma.subscription.deleteMany({ where: { id: { in: sids } } });
    await app.prisma.rider.deleteMany({ where: { userId: { in: ids } } });
    await app.prisma.user.deleteMany({ where: { id: { in: ids } } });
    await app.prisma.tenant.deleteMany({ where: { id: { in: tenants } } });
  }).catch(() => {});
  await app.close();
});

describe('[R10] the VAT tracker: weekly fees due and received per Guyana month', () => {
  it('counts each week once when it fell due, money when it came in, returns apart; the month counts the larger of due and received', async () => {
    const tenantId = await newTenant();
    const sub = await rider(tenantId);
    const run = nanoid(6);
    // September: 6,000 paid in early (fee credit), then the week of 7 Sep charged from it.
    await event(sub, 'PREPAID_TOPUP', 6000, '2026-09-05T15:00:00Z', `topup:${run}:1`);
    await event(sub, 'CHARGE_ATTEMPT', 6000, '2026-09-07T13:00:00Z', `charge:${sub}:2026-09-07:a0`);
    await event(sub, 'CHARGE_SUCCESS', 6000, '2026-09-07T13:00:01Z', `success:${sub}:2026-09-07`, 'prepaid');
    // October: the week of 5 Oct charged straight to MMG (received when it settled) ...
    await event(sub, 'CHARGE_ATTEMPT', 6000, '2026-10-05T13:00:00Z', `charge:${sub}:2026-10-05:a0`);
    await event(sub, 'CHARGE_SUCCESS', 6000, '2026-10-05T14:00:00Z', `success:${sub}:2026-10-05`, `mmgtx_${run}`);
    // ... the week of 12 Oct asked twice and never paid (still fell due, once) ...
    await event(sub, 'CHARGE_ATTEMPT', 6000, '2026-10-12T13:00:00Z', `charge:${sub}:2026-10-12:a0`);
    await event(sub, 'CHARGE_ATTEMPT', 6000, '2026-10-13T13:00:00Z', `charge:${sub}:2026-10-12:a1`);
    // ... and 1,000 MMG returned (shown, never netted).
    await event(sub, 'PREPAID_REVERSAL', 1000, '2026-10-14T13:00:00Z', `reversal:${run}:1`);

    const t = await sys(() => vatTracker(app.prisma, tenantId, NOW));

    expect(t.months).toHaveLength(12);
    expect(t.months[0]!.month).toBe('2025-11');
    expect(t.months[11]!.month).toBe('2026-10');
    expect(t.months.find((m) => m.month === '2026-09')).toEqual({ month: '2026-09', due: 6000, received: 6000, returned: 0, counted: 6000 });
    expect(t.months.find((m) => m.month === '2026-10')).toEqual({ month: '2026-10', due: 12000, received: 6000, returned: 1000, counted: 12000 });
    expect(t.last12Months).toBe(18000);
    expect(t).toMatchObject({ currencyCode: 'GYD', thresholdGyd: VAT_REGISTRATION_THRESHOLD_GYD, earlyAlertGyd: VAT_EARLY_ALERT_GYD, applyWithinDays: VAT_APPLY_WITHIN_DAYS, status: 'CLEAR' });
    expect(vatAlert(t)).toBeNull();
  });

  it('a fee another tenant took never counts here', async () => {
    const mine = await newTenant();
    const other = await newTenant();
    const theirs = await rider(other);
    await event(theirs, 'PREPAID_TOPUP', 50_000, '2026-10-02T13:00:00Z', `topup:${nanoid(6)}:other`);
    const t = await sys(() => vatTracker(app.prisma, mine, NOW));
    expect(t.last12Months).toBe(0);
    expect(t.expectedNext12Months).toBe(0);
  });
});

describe('[R10] the year ahead from today\'s partners', () => {
  it('52 weeks of every paying fee (a negotiated rate wins), a trial\'s remaining free weeks nil, a paused plan nothing', async () => {
    const tenantId = await newTenant();
    await rider(tenantId, { weeklyRate: 6000 }); // 52 x 6,000
    await rider(tenantId, { weeklyRate: 8000, customRate: 5000 }); // 52 x 5,000
    await rider(tenantId, { weeklyRate: 6000, status: 'TRIAL', trialEndDate: new Date(NOW.getTime() + 10 * DAY) }); // 2 weeks free: 50 x 6,000
    await rider(tenantId, { weeklyRate: 6000, status: 'PAUSED' }); // nothing
    const t = await sys(() => vatTracker(app.prisma, tenantId, NOW));
    expect(t.expectedNext12Months).toBe(52 * 6000 + 52 * 5000 + 50 * 6000);
    expect(t.expectedFrom).toEqual({ subscriptions: 3, weeklyFees: 17000 });
  });
});

describe('[R10] the admin alert names the threshold and the 15-day deadline', () => {
  it('expected to reach GYD 15,000,000 within the year ahead', async () => {
    const tenantId = await newTenant();
    await rider(tenantId, { weeklyRate: 300_000 }); // 52 x 300,000 = 15,600,000
    const t = await sys(() => vatTracker(app.prisma, tenantId, NOW));
    expect(t.status).toBe('EXPECTED_TO_REACH');
    const alert = vatAlert(t)!;
    expect(alert.title).toMatch(/expected to reach the registration threshold/i);
    expect(alert.body).toContain('GY$15,600,000');
    expect(alert.body).toContain('within 15 days');
    expect(alert.body).toContain('15,000,000');
  });

  it('GYD 10,000,000 received in the last 12 months is the early warning', async () => {
    const tenantId = await newTenant();
    const sub = await rider(tenantId, { status: 'PAUSED' });
    await event(sub, 'PREPAID_TOPUP', 10_000_000, '2026-06-10T13:00:00Z', `topup:${nanoid(6)}:big`);
    const t = await sys(() => vatTracker(app.prisma, tenantId, NOW));
    expect(t).toMatchObject({ last12Months: 10_000_000, status: 'EARLY_ALERT' });
    expect(vatAlert(t)!.title).toMatch(/passed GY\$10,000,000/);
  });

  it('reaching GYD 15,000,000 in the last 12 months says so first', () => {
    const base = { tenantId: 't', asOf: NOW.toISOString(), currencyCode: 'GYD' as const, months: [], expectedFrom: { subscriptions: 0, weeklyFees: 0 }, thresholdGyd: VAT_REGISTRATION_THRESHOLD_GYD, earlyAlertGyd: VAT_EARLY_ALERT_GYD, applyWithinDays: VAT_APPLY_WITHIN_DAYS };
    const reached: VatTracker = { ...base, last12Months: 15_000_000, expectedNext12Months: 20_000_000, status: 'THRESHOLD_REACHED' };
    expect(vatAlert(reached)!.title).toMatch(/have reached the registration threshold/);
    expect(vatAlert(reached)!.body).toMatch(/apply to the GRA within 15 days/);
  });
});
