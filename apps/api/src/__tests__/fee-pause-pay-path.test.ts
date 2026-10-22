// ---------------------------------------------------------------------------
// [22 Oct, COORD ruling on REVIEW-M's note] The fee pause counts MMG as a way
// to pay only when a partner can actually pay with it.
//
// Before: noLivePayPath = mmgDisabled && !weeklyFeeCardLive, so "MMG driver
// on" counted as a way to pay. Since #1998 (Option A) production never pushes,
// so the only MMG way to pay there is the checkout page. With MMG_DRIVER=live
// and the checkout off (or switched off on one platform), the fee was NOT
// paused: weeks failed, the ladder ran and a partner could be SUSPENDED with
// no way to pay (against the 5/6 Oct fee-pause rule). Now MMG counts only if:
//   - the push rail is on (mmgPushRailOn; never in production), OR
//   - the checkout is truly live: MMG_CHECKOUT_ENABLED=1, a configuration its
//     provider loads, and billing.feeCheckout.platforms on for EVERY platform
//     (read fresh: a partner's app may be any of them).
// Production also refuses to boot MMG_DRIVER=live without the checkout
// (boot-config.test.ts).
// Subjects are stores (vendor subscriptions): their fee has one owner.
// ---------------------------------------------------------------------------
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { generateKeyPair, type KeyObject } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import type { PaymentMethod } from '@prisma/client';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { socketPlugin } from '../plugins/socket';
import { BillingService, MMG_PUSH_OFF_REASON } from '../modules/billing/billing.service';
import { NotificationService } from '../modules/notification/notification.service';
import { getPaymentProvider } from '../providers/payment/payment-provider';
import { MMG_PUSH_RAIL_ENV } from '../providers/mmg/mmg-provider';
import { noLivePayPath } from '../modules/billing/fee-pause';
import { FEE_CHECKOUT_PLATFORMS_KEY, resetFeeCheckoutSwitchCache } from '../modules/billing/fee-pay-actions';
import { FEE_PAUSE_REPAIR_PREFIX, MMG_PAUSE_CLOCKS_KEY, feePauseStatus, syncMmgPauseClock } from '../modules/billing/mmg-pause';
import { retainedCohort, retainedPhonePrefix, retireKeptScaffolding, without } from './helpers/retained-evidence';
import { cleanupBillingClocks } from './helpers/billing-clock-cleanup';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
type Env = Record<string, string | undefined>;
const LIVE: Env = {
  MMG_DRIVER: 'live', MMG_API_URL: 'https://api.mmg.gy/olive/publisher/v1', MMG_API_KEY: 'k', MMG_MERCHANT_ID: '5926000000',
  MMG_PASSWORD: 'p', MMG_MKEY: 'mk', MMG_MSECRET: 'ms',
};

// Every key is generated here, for this file only: never a value from any MMG file.
let mmgPair: { publicKey: KeyObject; privateKey: KeyObject };
let swiftPair: { publicKey: KeyObject; privateKey: KeyObject };
const rsa = () => new Promise<{ publicKey: KeyObject; privateKey: KeyObject }>((resolve, reject) => {
  generateKeyPair('rsa', { modulusLength: 4096 }, (err, publicKey, privateKey) => (err ? reject(err) : resolve({ publicKey, privateKey })));
});
/** The MMG checkout switched on with a complete live configuration. */
function checkoutOn(): Env {
  return {
    MMG_CHECKOUT_ENABLED: '1', MMG_CHECKOUT_MERCHANT_ID: '0000001', MMG_CHECKOUT_CLIENT_ID: 'client-test',
    MMG_CHECKOUT_MERCHANT_NAME: 'Swift Test', MMG_CHECKOUT_RETURN_ORIGIN: 'https://pay.example.test',
    MMG_CHECKOUT_SECRET_KEY: 'not-a-secret',
    MMG_CHECKOUT_PUBLIC_KEY: mmgPair.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    MMG_CHECKOUT_PRIVATE_KEY: swiftPair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  };
}

/** A switch-row reader with no database: the row as given, every read counted. */
function rowReader(value: unknown | null) {
  const reader = {
    reads: 0,
    value,
    platformConfig: {
      findUnique: async ({ where }: { where: { key: string } }) => {
        reader.reads += 1;
        expect(where.key).toBe(FEE_CHECKOUT_PLATFORMS_KEY);
        return reader.value === null ? null : { value: reader.value };
      },
    },
  };
  return reader;
}
const paused = (reader: ReturnType<typeof rowReader>, env: Env) => noLivePayPath(reader as never, env);

beforeAll(async () => {
  [mmgPair, swiftPair] = await Promise.all([rsa(), rsa()]);
}, 120_000);

describe('the pay-path truth table (no database)', () => {
  const test = (env: Env): Env => ({ NODE_ENV: 'test', ...env });

  it('MMG off: paused, and the switch row is never read', async () => {
    const reader = rowReader(null);
    expect(await paused(reader, test({ MMG_DRIVER: 'disabled' }))).toBe(true);
    expect(await paused(reader, test({ MMG_DRIVER: 'disabled', ...checkoutOn() }))).toBe(true);
    expect(reader.reads).toBe(0);
  });

  it('the push rail on (the sandbox off production, or live with the switch and the round trip) is a way to pay', async () => {
    const reader = rowReader({ ios: false, android: false, web: false });
    expect(await paused(reader, test({}))).toBe(false);
    expect(await paused(reader, test({ MMG_DRIVER: 'sandbox' }))).toBe(false);
    expect(await paused(reader, test({ ...LIVE, MMG_REFERENCE_ROUNDTRIP_VERIFIED: '1', [MMG_PUSH_RAIL_ENV]: '1' }))).toBe(false);
    expect(reader.reads).toBe(0);
  });

  it('[the gap] live MMG with the push rail off and the checkout off: no MMG way to pay, so the fee is PAUSED', async () => {
    const reader = rowReader(null);
    expect(await paused(reader, test(LIVE))).toBe(true);
    expect(await paused(reader, test({ ...LIVE, MMG_REFERENCE_ROUNDTRIP_VERIFIED: '1' }))).toBe(true);
    expect(await paused(reader, test({ ...LIVE, MMG_CHECKOUT_ENABLED: '0' }))).toBe(true);
    // A near-miss switch is not on (the boot guard refuses it too).
    expect(await paused(reader, test({ ...LIVE, ...checkoutOn(), MMG_CHECKOUT_ENABLED: 'true' }))).toBe(true);
    // Production: the push rail is refused, so the checkout is the only MMG way to pay.
    expect(await paused(reader, { ...LIVE, NODE_ENV: 'production', MMG_REFERENCE_ROUNDTRIP_VERIFIED: '1', [MMG_PUSH_RAIL_ENV]: '1' })).toBe(true);
  });

  it('the checkout switched on but its configuration incomplete is no way to pay', async () => {
    const reader = rowReader(null);
    for (const missing of ['MMG_CHECKOUT_MERCHANT_ID', 'MMG_CHECKOUT_PUBLIC_KEY', 'MMG_CHECKOUT_PRIVATE_KEY', 'MMG_CHECKOUT_RETURN_ORIGIN']) {
      expect(await paused(reader, test({ ...LIVE, ...checkoutOn(), [missing]: undefined })), missing).toBe(true);
    }
    // The control: the same configuration complete is a way to pay.
    expect(await paused(reader, test({ ...LIVE, ...checkoutOn() }))).toBe(false);
  });

  it('the checkout live on EVERY platform is a way to pay (a missing row or platform counts as on); one platform off pauses every fee', async () => {
    const env = test({ ...LIVE, ...checkoutOn() });
    const reader = rowReader(null);
    expect(await paused(reader, env)).toBe(false);
    for (const on of [{}, { ios: true }, { ios: true, android: true, web: true }]) {
      reader.value = on;
      expect(await paused(reader, env), JSON.stringify(on)).toBe(false);
    }
    for (const off of [{ ios: false }, { android: false }, { web: false }, { ios: true, android: true, web: false }, { ios: false, android: false, web: false }]) {
      reader.value = off;
      expect(await paused(reader, env), JSON.stringify(off)).toBe(true);
    }
    // [DS633] A value that is not a real boolean, or a row that is not an object, switches off.
    for (const bad of [{ web: 'false' }, { ios: 0 }, 'off', [], 1]) {
      reader.value = bad;
      expect(await paused(reader, env), JSON.stringify(bad)).toBe(true);
    }
  });

  it('production with the checkout fully live is a way to pay', async () => {
    const env = { ...LIVE, ...checkoutOn(), NODE_ENV: 'production', MMG_CHECKOUT_URL: 'https://checkout.example.test/mmg-pg/web/payments' };
    const reader = rowReader(null);
    expect(await paused(reader, env)).toBe(false);
    reader.value = { ios: false };
    expect(await paused(reader, env)).toBe(true);
  });

  it('the switch row is read fresh every time (never the pay actions\' one-minute cache)', async () => {
    const env = test({ ...LIVE, ...checkoutOn() });
    const reader = rowReader({ ios: true });
    expect(await paused(reader, env)).toBe(false);
    reader.value = { ios: false };
    expect(await paused(reader, env)).toBe(true);
    reader.value = { ios: true };
    expect(await paused(reader, env)).toBe(false);
    expect(reader.reads).toBe(3);
  });

  it('a live card rail is a way to pay whatever MMG is', async () => {
    const reader = rowReader({ ios: false });
    const cardLive = { CARD_RAIL_V2: '1', CARD_RAIL_KILL: '0', PAYMENT_PROVIDER: 'sandbox', CARD_RAIL_PROVIDER: 'powertranz' };
    expect(await paused(reader, test({ ...LIVE, ...cardLive }))).toBe(false);
    expect(await paused(reader, test({ ...LIVE, ...cardLive, CARD_RAIL_KILL: '1' }))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The billing run, for real.
// ---------------------------------------------------------------------------
let app: FastifyInstance;
let billing: BillingService;
const userIds: string[] = [];
const subIds: string[] = [];
let seq = 0;
const PHONE_PREFIX = retainedPhonePrefix('31');

async function makeVendorSub(method: PaymentMethod, due = new Date(Date.now() - 60_000)) {
  seq += 1;
  const user = await app.prisma.user.create({
    data: {
      phone: `${PHONE_PREFIX}${String(seq).padStart(3, '0')}`,
      firstName: 'Pay', lastName: `Path${seq}`,
      roles: ['VENDOR_OWNER'], activeRole: 'VENDOR_OWNER', isPhoneVerified: true, selfieCapturedAt: new Date(),
    },
  });
  userIds.push(user.id);
  const owner = await app.prisma.vendorOwner.create({ data: { userId: user.id } });
  const vendor = await app.prisma.vendor.create({
    data: {
      ownerId: owner.id, name: `Pay Path Store ${seq}`, slug: `pay-path-${nanoid(8).toLowerCase()}`,
      vendorType: 'RESTAURANT', phone: `${PHONE_PREFIX}9${String(seq).padStart(2, '0')}`,
      addressLine1: '1 Checkout Street', city: 'Georgetown', region: 'Demerara-Mahaica', latitude: 6.8, longitude: -58.15,
      status: 'ACTIVE', acceptingOrders: true, isVerified: true,
    },
  });
  const sub = await app.prisma.subscription.create({
    data: {
      vendorId: vendor.id, type: 'RESTAURANT', status: 'ACTIVE', weeklyRate: 12000,
      billingMethod: method,
      mmgPayerMsisdn: method === 'MOBILE_MONEY' ? `6093${String(seq).padStart(3, '0')}` : null,
      currentPeriodStart: new Date(due.getTime() - 7 * DAY), currentPeriodEnd: due, nextBillingDate: due,
    },
  });
  subIds.push(sub.id);
  return sub.id;
}

const withRelations = (id: string) => app.prisma.subscription.findUniqueOrThrow({
  where: { id },
  include: { rider: { select: { userId: true } }, driver: { select: { userId: true } }, vendor: { select: { id: true, owner: { select: { userId: true } } } } },
});
async function facts(subId: string) {
  const owner = (await withRelations(subId)).vendor!.owner.userId;
  const [s, events, told] = await Promise.all([
    app.prisma.subscription.findUniqueOrThrow({ where: { id: subId } }),
    app.prisma.billingEvent.findMany({ where: { subscriptionId: subId }, select: { type: true, note: true } }),
    app.prisma.notification.findMany({ where: { userId: owner }, select: { data: true } }),
  ]);
  return {
    status: s.status,
    failedAttempts: s.failedAttempts,
    failed: events.filter((e) => e.type === 'CHARGE_FAILED').map((e) => e.note),
    attempts: events.filter((e) => e.type === 'CHARGE_ATTEMPT').length,
    suspendedEvents: events.filter((e) => e.type === 'SUSPENDED').length,
    kinds: told.map((n) => (n.data as { kind?: string } | null)?.kind).filter(Boolean),
  };
}
function stub(env: Env) {
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
}
async function setPlatforms(value: unknown | null) {
  if (value === null) await app.prisma.platformConfig.deleteMany({ where: { key: FEE_CHECKOUT_PLATFORMS_KEY } });
  else await app.prisma.platformConfig.upsert({ where: { key: FEE_CHECKOUT_PLATFORMS_KEY }, create: { key: FEE_CHECKOUT_PLATFORMS_KEY, value: value as never }, update: { value: value as never } });
  resetFeeCheckoutSwitchCache();
}
/** The sandbox (push rail on) resumes any pause a case opened; then the pause's own rows go. */
async function noPauseOpen(): Promise<void> {
  await syncMmgPauseClock(app.prisma, new Date(), { NODE_ENV: 'test', MMG_DRIVER: 'sandbox' });
  await app.prisma.platformConfig.deleteMany({ where: { OR: [
    { key: { in: [MMG_PAUSE_CLOCKS_KEY, 'billing.mmg_pause.open'] } }, { key: { startsWith: FEE_PAUSE_REPAIR_PREFIX } },
  ] } });
}

beforeAll(async () => {
  process.env['NODE_ENV'] = 'development';
  app = Fastify({ logger: false });
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(socketPlugin);
  await app.ready();
  billing = new BillingService(app.prisma, new NotificationService(app.prisma, app.io), getPaymentProvider());
  await setPlatforms(null);
  await noPauseOpen();
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await setPlatforms(null);
  if (subIds.length > 0) {
    await app.prisma.subscription.updateMany({ where: { id: { in: subIds }, status: { not: 'CANCELLED' } }, data: { status: 'CANCELLED', autoRenew: false } });
  }
});

afterAll(async () => {
  vi.unstubAllEnvs();
  try {
    await setPlatforms(null);
    await app.prisma.$transaction(async (tx) => {
      const kept = await retainedCohort(tx, { subscriptionIds: subIds });
      const goneSubs = without(subIds, kept.subscriptionIds);
      await cleanupBillingClocks(tx, goneSubs);
      await tx.billingEvent.deleteMany({ where: { subscriptionId: { in: goneSubs } } });
      await tx.subscriptionPayment.deleteMany({ where: { subscriptionId: { in: goneSubs } } });
      await tx.prepaidBalance.deleteMany({ where: { subscriptionId: { in: goneSubs } } });
      await tx.subscription.deleteMany({ where: { id: { in: goneSubs } } });
      await tx.notification.deleteMany({ where: { userId: { in: userIds } } });
      await retireKeptScaffolding(tx, kept);
    }, { timeout: 60_000 });
  } catch {
    // Retained money evidence may keep some scaffolding; the suite's rows are unique to this run.
  } finally {
    await app.close();
  }
});

describe('live MMG with the push rail off and the checkout off: every fee is paused', () => {
  it.each(['MOBILE_MONEY', 'CASH'] as const)('a %s week is paused: no attempt, no failure, no notice, still ACTIVE', async (method) => {
    const subId = await makeVendorSub(method);
    stub({ ...LIVE, MMG_REFERENCE_ROUNDTRIP_VERIFIED: '1' });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('a paused fee never contacts MMG'));
    expect(await billing.billSubscription((await withRelations(subId)) as any)).toBe('pending');
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await facts(subId)).toEqual({ status: 'ACTIVE', failedAttempts: 0, failed: [], attempts: 0, suspendedEvents: 0, kinds: [] });
  });

  it('an admin sees the pause (reason NO_LIVE_PAY_PATH)', async () => {
    expect(await feePauseStatus(app.prisma, {}, new Date(), { NODE_ENV: 'development', ...LIVE })).toMatchObject({ paused: true, reason: 'NO_LIVE_PAY_PATH' });
    expect(await feePauseStatus(app.prisma, {}, new Date(), { NODE_ENV: 'development', ...LIVE, ...checkoutOn() })).toMatchObject({ paused: false, reason: null });
  });

  it('the pause tick opens the span and names the case in the audit row; the push rail back resumes it', async () => {
    const t0 = new Date();
    try {
      const out = await syncMmgPauseClock(app.prisma, t0, { NODE_ENV: 'development', ...LIVE });
      expect(out).toMatchObject({ paused: true });
      const started = await app.prisma.auditLog.findMany({ where: { action: 'BILLING_FEE_PAUSE_STARTED', createdAt: { gte: new Date(t0.getTime() - 1000) } }, select: { changes: true } });
      expect(started).toHaveLength(1);
      expect(started[0]!.changes).toMatchObject({ reason: 'NO_LIVE_PAY_PATH', mmg: 'no-push-rail-no-live-checkout', card: 'off' });
    } finally {
      await noPauseOpen();
    }
  });
});

describe('live MMG with the checkout fully live: fees are billed as before (the control)', () => {
  it('a MOBILE_MONEY week fails with the push-off note (nothing reaches MMG) and a CASH week fails as cash', async () => {
    const mmg = await makeVendorSub('MOBILE_MONEY');
    const cash = await makeVendorSub('CASH');
    stub({ ...LIVE, MMG_REFERENCE_ROUNDTRIP_VERIFIED: '1', ...checkoutOn() });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('the push rail is off: MMG must not be contacted'));
    expect(await billing.billSubscription((await withRelations(mmg)) as any)).toBe('failed');
    expect(await billing.billSubscription((await withRelations(cash)) as any)).toBe('failed');
    expect(fetchSpy).not.toHaveBeenCalled();
    expect((await facts(mmg)).failed).toEqual([MMG_PUSH_OFF_REASON]);
    const cashFacts = await facts(cash);
    expect(cashFacts.failed).toHaveLength(1);
    expect(cashFacts.failed[0]).not.toBe(MMG_PUSH_OFF_REASON);
  });

  it.each([
    ['ios', { ios: false }],
    ['android', { android: false }],
    ['web', { web: false }],
  ])('with the checkout switched off on %s, the same weeks are paused', async (_platform, row) => {
    const mmg = await makeVendorSub('MOBILE_MONEY');
    const cash = await makeVendorSub('CASH');
    stub({ ...LIVE, MMG_REFERENCE_ROUNDTRIP_VERIFIED: '1', ...checkoutOn() });
    await setPlatforms(row);
    expect(await billing.billSubscription((await withRelations(mmg)) as any)).toBe('pending');
    expect(await billing.billSubscription((await withRelations(cash)) as any)).toBe('pending');
    for (const subId of [mmg, cash]) {
      expect(await facts(subId)).toEqual({ status: 'ACTIVE', failedAttempts: 0, failed: [], attempts: 0, suspendedEvents: 0, kinds: [] });
    }
  });
});

describe('the ladder: nobody is suspended once the last MMG way to pay goes', () => {
  /** Bills the subscription at t0 + k * 25 h for k = from..to, returning each outcome. */
  async function ladder(subId: string, t0: Date, from: number, to: number) {
    const out: string[] = [];
    for (let k = from; k <= to; k += 1) {
      out.push(await billing.billSubscription((await withRelations(subId)) as any, new Date(t0.getTime() + k * 25 * HOUR)));
    }
    return out;
  }

  it('control: with the checkout live the whole time, a push-off week runs the ladder to SUSPENDED', async () => {
    const subId = await makeVendorSub('MOBILE_MONEY');
    stub({ ...LIVE, MMG_REFERENCE_ROUNDTRIP_VERIFIED: '1', ...checkoutOn() });
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('the push rail is off: MMG must not be contacted'));
    const t0 = new Date();
    expect(await ladder(subId, t0, 0, 1)).toEqual(['failed', 'failed']);
    expect(await facts(subId)).toMatchObject({ status: 'PAST_DUE', failedAttempts: 2 });
    const rest = await ladder(subId, t0, 2, 8);
    expect(rest).toContain('suspended');
    const f = await facts(subId);
    expect(f.status).toBe('SUSPENDED');
    expect(f.kinds).toContain('billing_suspended');
  });

  it('the checkout switched off on iOS after two failed weeks: every later run is paused, never SUSPENDED, nothing more written', async () => {
    const subId = await makeVendorSub('MOBILE_MONEY');
    stub({ ...LIVE, MMG_REFERENCE_ROUNDTRIP_VERIFIED: '1', ...checkoutOn() });
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('the push rail is off: MMG must not be contacted'));
    const t0 = new Date();
    expect(await ladder(subId, t0, 0, 1)).toEqual(['failed', 'failed']);
    const before = await facts(subId);
    expect(before).toMatchObject({ status: 'PAST_DUE', failedAttempts: 2 });
    await setPlatforms({ ios: false });
    expect(await ladder(subId, t0, 2, 8)).toEqual(Array(7).fill('pending'));
    const after = await facts(subId);
    expect(after).toEqual(before);
    expect(after.status).toBe('PAST_DUE');
    expect(after.kinds).not.toContain('billing_suspended');
  });

  it('the checkout config dropped after two failed weeks (MMG_CHECKOUT_ENABLED=0): the same, never SUSPENDED', async () => {
    const subId = await makeVendorSub('MOBILE_MONEY');
    stub({ ...LIVE, MMG_REFERENCE_ROUNDTRIP_VERIFIED: '1', ...checkoutOn() });
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('the push rail is off: MMG must not be contacted'));
    const t0 = new Date();
    expect(await ladder(subId, t0, 0, 1)).toEqual(['failed', 'failed']);
    const before = await facts(subId);
    vi.stubEnv('MMG_CHECKOUT_ENABLED', '0');
    expect(await ladder(subId, t0, 2, 8)).toEqual(Array(7).fill('pending'));
    expect(await facts(subId)).toEqual(before);
  });
});
