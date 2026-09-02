import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import type { UserRole } from '@prisma/client';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { registerErrorHandler } from '../middleware/error-handler';
import { BillingService } from '../modules/billing/billing.service';
import { NotificationService } from '../modules/notification/notification.service';
import { getPaymentProvider } from '../providers/payment/payment-provider';
import {
  SandboxMmgProvider, sandboxAddHistory, sandboxResetMmg, sandboxSetTxStatus, type MmgInitiateRequest,
} from '../providers/mmg/mmg-provider';
import { syntheticLocationOwner } from './helpers/online-mover';

// ---------------------------------------------------------------------------
// [TA-S0-002 / M-03] No MMG request may exist without a durable local intent.
//
// The weekly-fee charge used to write its payment row AFTER MMG answered. A
// process that died between MMG accepting the request and the row landing
// left a live prompt on the payer's phone that nothing here could poll,
// settle, bank or retry — and the next run collided on the attempt key and
// skipped forever. Now the intent (UNKNOWN, our clientKey, no provider id)
// is reserved BEFORE MMG is asked, every outcome settles that one row, and a
// run that dies at any point leaves a row the poller already owns.
//
// Against the real database, Redis and the sandbox provider, spied at the
// exact call so the database can be inspected at the moment MMG is asked.
// ---------------------------------------------------------------------------

const DAY = 24 * 60 * 60 * 1000;
const PHONE_PREFIX = '+59200672';
let app: FastifyInstance;
let billing: BillingService;
const userIds: string[] = [];
const subIds: string[] = [];
let seq = 0;

async function makeMoverWithMmgSub(opts: { due: Date; msisdn: string }) {
  seq += 1;
  const user = await app.prisma.user.create({
    data: {
      phone: `${PHONE_PREFIX}${String(seq).padStart(2, '0')}`,
      firstName: 'Intent', lastName: `U${seq}`,
      roles: ['MOVER', 'CUSTOMER'] as UserRole[], activeRole: 'MOVER', isPhoneVerified: true, selfieCapturedAt: new Date(),
    },
  });
  userIds.push(user.id);
  const token = app.jwt.sign({ userId: user.id, role: 'MOVER', jti: nanoid(8) });
  await app.prisma.session.create({
    data: { userId: user.id, token, refreshToken: nanoid(48), deviceId: 'intent-test', deviceType: 'test', expiresAt: new Date(Date.now() + DAY) },
  });
  const rider = await app.prisma.rider.create({
    data: { userId: user.id, riderType: 'DELIVERY', vehicleType: 'MOTORCYCLE', documentsVerified: true, isOnline: true, locationSessionId: syntheticLocationOwner('billing-intent') },
  });
  const sub = await app.prisma.subscription.create({
    data: {
      riderId: rider.id,
      type: 'DELIVERY_RIDER',
      status: 'ACTIVE',
      weeklyRate: 12000,
      billingMethod: 'MOBILE_MONEY',
      mmgPayerMsisdn: opts.msisdn,
      currentPeriodStart: new Date(opts.due.getTime() - 7 * DAY),
      currentPeriodEnd: opts.due,
      nextBillingDate: opts.due,
    },
  });
  subIds.push(sub.id);
  return { subId: sub.id };
}

async function subWithRelations(subId: string) {
  return app.prisma.subscription.findUniqueOrThrow({
    where: { id: subId },
    include: {
      rider: { select: { userId: true } },
      driver: { select: { userId: true } },
      vendor: { select: { id: true, owner: { select: { userId: true } } } },
    },
  });
}

/** The ONE reference format — pinned here so a drift in the service breaks adoption visibly. */
function referenceFor(sub: { id: string; nextBillingDate: Date; failedAttempts: number }): string {
  return `sub:${sub.id}:${sub.nextBillingDate.toISOString().slice(0, 10)}:a${sub.failedAttempts}`;
}

const rowsFor = (subId: string) => app.prisma.subscriptionPayment.findMany({ where: { subscriptionId: subId }, orderBy: { createdAt: 'asc' } });

beforeAll(async () => {
  process.env['NODE_ENV'] = 'development';
  process.env['DATABASE_URL'] = process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift';
  process.env['REDIS_URL'] = process.env['REDIS_URL'] || 'redis://localhost:6382';
  delete process.env['MMG_DRIVER']; // sandbox

  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  await app.ready();
  billing = new BillingService(app.prisma, new NotificationService(app.prisma, app.io), getPaymentProvider());
});

afterEach(() => {
  vi.restoreAllMocks();
  sandboxResetMmg();
});

afterAll(async () => {
  await app.prisma.billingEvent.deleteMany({ where: { subscriptionId: { in: subIds } } });
  await app.prisma.subscriptionPayment.deleteMany({ where: { subscriptionId: { in: subIds } } });
  await app.prisma.subscription.deleteMany({ where: { id: { in: subIds } } });
  await app.prisma.notification.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.rider.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.session.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await app.close();
});

describe('[TA-S0-002] the intent exists before the effect', () => {
  it('the durable intent is on the database at the moment MMG is asked, and MMG’s answer lands on that same row', async () => {
    const due = new Date(Date.now() - 60_000);
    const { subId } = await makeMoverWithMmgSub({ due, msisdn: '6096720' });
    const sub = await subWithRelations(subId);
    const reference = referenceFor(sub);

    let rowAtInitiate: { id: string; status: string; externalRef: string | null } | null = null;
    const original = SandboxMmgProvider.prototype.initiatePayment;
    const spy = vi.spyOn(SandboxMmgProvider.prototype, 'initiatePayment').mockImplementation(
      async function (this: SandboxMmgProvider, req: MmgInitiateRequest) {
        // What the database holds at the exact moment the provider is called.
        rowAtInitiate = await app.prisma.subscriptionPayment.findUnique({
          where: { clientKey: req.reference }, select: { id: true, status: true, externalRef: true },
        });
        return original.call(this, req);
      },
    );

    expect(await billing.billSubscription(sub as never)).toBe('pending');
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]![0]!.reference).toBe(reference);
    expect(rowAtInitiate).toMatchObject({ status: 'UNKNOWN', externalRef: null });

    const rows = await rowsFor(subId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(rowAtInitiate!.id); // the SAME row, not a second one
    expect(rows[0]).toMatchObject({ status: 'PENDING', clientKey: reference, failureCode: null });
    expect(rows[0]!.externalRef).toBeTruthy();
  });

  it('a run that dies after MMG accepted the request never prompts twice: the next run is "pending", the poller adopts the original by our reference and settles it once', async () => {
    const due = new Date(Date.now() - 60_000);
    const { subId } = await makeMoverWithMmgSub({ due, msisdn: '6096721' });
    const sent: MmgInitiateRequest[] = [];
    vi.spyOn(SandboxMmgProvider.prototype, 'initiatePayment').mockImplementation(async (req: MmgInitiateRequest) => {
      sent.push(req);
      // MMG accepted it — a prompt is on the payer's phone — and our process
      // died before it could hear the answer.
      throw new Error('process died after MMG accepted the request');
    });

    await expect(billing.billSubscription((await subWithRelations(subId)) as never)).rejects.toThrow('process died');
    expect(sent).toHaveLength(1);
    const reference = sent[0]!.reference;

    // The durable intent survived the crash: UNKNOWN, our reference, no provider id.
    const intent = await app.prisma.subscriptionPayment.findUniqueOrThrow({ where: { clientKey: reference } });
    expect(intent).toMatchObject({ subscriptionId: subId, status: 'UNKNOWN', externalRef: null });

    // The next run: the attempt is "pending", not "skipped" — and MMG is NOT asked again.
    expect(await billing.billSubscription((await subWithRelations(subId)) as never)).toBe('pending');
    expect(sent).toHaveLength(1);
    expect(await rowsFor(subId)).toHaveLength(1);

    // The poller adopts MMG's id from its history by OUR reference…
    const minor = Math.round(Number(intent.amount) * 100);
    const txId = `mmgtx_approved_amt${minor}_${nanoid(10)}`;
    sandboxAddHistory({ transactionId: txId, status: 'pending', amountMinor: minor, currencyCode: 'GYD', reference });
    const adopted = await billing.pollPendingMmgCharges();
    expect(adopted.adopted).toBeGreaterThanOrEqual(1);
    expect(await app.prisma.subscriptionPayment.findUniqueOrThrow({ where: { id: intent.id } })).toMatchObject({ status: 'PENDING', externalRef: txId });

    // …then settles the approval on the same row, once (a later tick, past the row's poll backoff).
    sandboxSetTxStatus(txId, 'approved');
    const settled = await billing.pollPendingMmgCharges(new Date(Date.now() + 10 * 60_000));
    expect(settled.settled).toBeGreaterThanOrEqual(1);

    const rows = await rowsFor(subId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: intent.id, status: 'CAPTURED', externalRef: txId });
    const after = await app.prisma.subscription.findUniqueOrThrow({ where: { id: subId } });
    expect(after.nextBillingDate.getTime()).toBe(due.getTime() + 7 * DAY);
    expect(await app.prisma.billingEvent.count({ where: { subscriptionId: subId, type: 'CHARGE_SUCCESS' } })).toBe(1);
  });

  it('MMG saying "no" at initiate closes the intent as FAILED on the same row, with the normalized code, and duns as before', async () => {
    const due = new Date(Date.now() - 60_000);
    const { subId } = await makeMoverWithMmgSub({ due, msisdn: '6096722' });
    vi.spyOn(SandboxMmgProvider.prototype, 'initiatePayment').mockResolvedValue({ status: 'declined', transactionId: '', reason: 'Payer declined (test)' });

    expect(await billing.billSubscription((await subWithRelations(subId)) as never)).toBe('failed');
    const rows = await rowsFor(subId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'FAILED', externalRef: null });
    expect(rows[0]!.failureCode).toBeTruthy();
    const after = await app.prisma.subscription.findUniqueOrThrow({ where: { id: subId } });
    expect(after.failedAttempts).toBe(1);
    expect(after.nextBillingDate.getTime()).toBe(due.getTime()); // not advanced
  });

  it('MMG approving at initiate settles the SAME row — CAPTURED with the provider id, never a second row', async () => {
    const due = new Date(Date.now() - 60_000);
    const { subId } = await makeMoverWithMmgSub({ due, msisdn: '6096723' });
    const txId = `mmgtx_approved_now_${nanoid(10)}`;
    vi.spyOn(SandboxMmgProvider.prototype, 'initiatePayment').mockResolvedValue({ status: 'approved', transactionId: txId });

    expect(await billing.billSubscription((await subWithRelations(subId)) as never)).toBe('succeeded');
    const rows = await rowsFor(subId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'CAPTURED', externalRef: txId, failureCode: null });
    expect(rows[0]!.paidAt).not.toBeNull();
    const after = await app.prisma.subscription.findUniqueOrThrow({ where: { id: subId } });
    expect(after.nextBillingDate.getTime()).toBe(due.getTime() + 7 * DAY);
  });

  it('a transport-shaped failure at initiate keeps the reserved row UNKNOWN with the timeout code — the poller owns it', async () => {
    const due = new Date(Date.now() - 60_000);
    const { subId } = await makeMoverWithMmgSub({ due, msisdn: '6096724' });
    vi.spyOn(SandboxMmgProvider.prototype, 'initiatePayment').mockResolvedValue({ status: 'error', transactionId: '', reason: 'Gateway timeout (test)' });

    expect(await billing.billSubscription((await subWithRelations(subId)) as never)).toBe('pending');
    const rows = await rowsFor(subId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'UNKNOWN', externalRef: null, failureCode: 'TIMEOUT_UNKNOWN' });
    expect(rows[0]!.clientKey).toBe(referenceFor(await subWithRelations(subId)));
  });
});
