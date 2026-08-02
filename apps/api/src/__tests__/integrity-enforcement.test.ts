import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { registerErrorHandler } from '../middleware/error-handler';
import { VerificationService } from '../modules/verification/verification.service';
import { NotificationService } from '../modules/notification/notification.service';
import { getKycProvider } from '../providers/kyc/kyc-provider';
import { captureSignup } from '../modules/integrity/capture-hooks';
import { hasActiveHold, previewTrial, openAppeal, resolveAppeal, appealOverturnRate, ENFORCEMENT_COPY } from '../modules/integrity/enforcement';
import { IdentityService } from '../modules/integrity/identity.service';
import { SubscriptionService } from '../modules/subscription/subscription.service';
import { normalizeDocNumber } from '../modules/integrity/normalize';

// Trial-integrity Part 4/5 — the enforcement ladder. Under test: the device-
// velocity rule flags the Nth signup (scenario H) and the flag means a HUMAN
// approves (auto-approve refused); the told-before-they-commit preview speaks
// the canonical copy; and the appeal loop (scenario K) ends in a
// FOUNDER_OVERRIDE exception the trial law honors. The overturn-rate metric
// (Part 10's false-positive alarm) computes from the same rows.

let app: FastifyInstance;
const userIds: string[] = [];
const vendorIds: string[] = [];
let seq = 0;
const phoneBase = 592_895_000_000 + Math.floor(Math.random() * 4_000_000);

async function makeUser() {
  seq += 1;
  const u = await app.prisma.user.create({
    data: {
      phone: `+${phoneBase + seq}`, firstName: 'Enf', lastName: `U${seq}`,
      roles: ['VENDOR_OWNER', 'CUSTOMER'], activeRole: 'VENDOR_OWNER', isPhoneVerified: true,
      avatar: 'https://x/selfie.jpg', selfieCapturedAt: new Date(),
    },
  });
  userIds.push(u.id);
  return u;
}

async function makeVendorFor(userId: string) {
  const owner = await app.prisma.vendorOwner.upsert({ where: { userId }, create: { userId }, update: {} });
  const vendor = await app.prisma.vendor.create({
    data: {
      ownerId: owner.id,
      name: `Enf Vendor ${seq}-${nanoid(4)}`, slug: `enf-${nanoid(8).toLowerCase()}`,
      vendorType: 'RESTAURANT', phone: `+${phoneBase + 800_000 + seq}`,
      addressLine1: '2 Enforcement Street', city: 'Georgetown', region: 'Demerara-Mahaica',
      latitude: 6.8, longitude: -58.15,
      status: 'ACTIVE', acceptingOrders: true, isVerified: true,
    },
  });
  vendorIds.push(vendor.id);
  return vendor;
}

async function waitFor<T>(fn: () => Promise<T | null>, tries = 40): Promise<T | null> {
  for (let i = 0; i < tries; i += 1) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 50));
  }
  return null;
}

beforeAll(async () => {
  process.env['NODE_ENV'] = 'development';
  process.env['DATABASE_URL'] = process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift_test';
  process.env['REDIS_URL'] = process.env['REDIS_URL'] || 'redis://localhost:6382';
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  await app.ready();
  await app.prisma.$executeRawUnsafe(
    `CREATE UNIQUE INDEX IF NOT EXISTS "trial_grants_one_active" ON "trial_grants" ("tenantId", "clusterId", "role") WHERE status = 'ACTIVE'`,
  );
});

afterAll(async () => {
  const members = await app.prisma.identityClusterMember.findMany({ where: { accountId: { in: userIds } }, select: { clusterId: true } });
  const clusterIds = [...new Set(members.map((m) => m.clusterId))];
  await app.prisma.enforcementAction.deleteMany({ where: { accountId: { in: userIds } } });
  await app.prisma.trialGrant.deleteMany({ where: { accountId: { in: userIds } } });
  await app.prisma.identityKey.deleteMany({ where: { accountId: { in: userIds } } });
  await app.prisma.identityClusterMember.deleteMany({ where: { accountId: { in: userIds } } });
  await app.prisma.exceptionGrant.deleteMany({ where: { clusterId: { in: clusterIds } } });
  await app.prisma.identityCluster.deleteMany({ where: { OR: [{ id: { in: clusterIds } }, { mergedIntoId: { in: clusterIds } }] } });
  await app.prisma.verificationDocument.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.subscription.deleteMany({ where: { vendorId: { in: vendorIds } } });
  await app.prisma.vendor.deleteMany({ where: { id: { in: vendorIds } } });
  await app.prisma.vendorOwner.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.notification.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await app.close();
});

describe('scenario H — device velocity (Part 5)', () => {
  it('the 3rd signup from one device in 24h enters REVIEW_FIRST; earlier ones are untouched', async () => {
    const device = `dev-${nanoid(10)}`;
    const [u1, u2, u3] = [await makeUser(), await makeUser(), await makeUser()];
    for (const u of [u1, u2, u3]) {
      captureSignup(app.prisma, { userId: u.id, role: 'VENDOR', phone: u.phone, deviceId: device, ip: '190.83.99.7' });
      // Sequential settle — the velocity count is per completed attempt.
      await waitFor(() => app.prisma.signupAttempt.findFirst({ where: { deviceHash: { not: null }, outcome: { in: ['CREATED', 'REVIEW_FIRST'] }, createdAt: { gte: new Date(Date.now() - 5000) } } }));
      await new Promise((r) => setTimeout(r, 120));
    }
    const flag = await waitFor(() => app.prisma.enforcementAction.findFirst({ where: { accountId: u3.id, level: 'REVIEW_FIRST', reasonCode: 'VELOCITY_DEVICE' } }));
    expect(flag).toBeTruthy();
    expect((await hasActiveHold(app.prisma, u3.id)).held).toBe(true);
    expect((await hasActiveHold(app.prisma, u1.id)).held).toBe(false);
  });

  it('a held account is NEVER auto-approved — the document goes to a human', async () => {
    const u = await makeUser();
    await app.prisma.enforcementAction.create({
      data: { accountId: u.id, level: 'REVIEW_FIRST', reasonCode: 'VELOCITY_DEVICE', signalsFired: [] as never, decidedBy: 'SYSTEM' },
    });
    const verification = new VerificationService(app.prisma, new NotificationService(app.prisma, app.io), getKycProvider());
    // The sandbox marker would auto-approve a clean account; the hold forces
    // pending_manual — rung 2's whole meaning.
    const doc = await verification.submitIdentity(u.id, 'https://x/id-auto-approve.jpg', 'https://x/selfie-auto-approve.jpg', 'v1');
    expect(doc.status).toBe('PENDING');
  });
});

describe('told before they commit (Part 4 copy)', () => {
  it('a consumed-trial human sees copy #3; an active-elsewhere human sees copy #2', async () => {
    const identity = new IdentityService(app.prisma);
    const subs = new SubscriptionService(app.prisma);
    const doc = `ID-${nanoid(8)}`;
    const h1 = await makeUser();
    const h2 = await makeUser();
    for (const h of [h1, h2]) {
      await identity.capture({ accountId: h.id, tenantId: 'swift-default', actorRole: 'VENDOR', type: 'ID_DOC_NUMBER', normalizedValue: normalizeDocNumber(doc), source: 'AI_ID_ANALYZER' });
    }
    await subs.startTrialForVendor((await makeVendorFor(h1.id)).id); // ACTIVE trial on h1

    const activeElsewhere = await previewTrial(app.prisma, h2.id, 'VENDOR', 'swift-default');
    expect(activeElsewhere.willTrial).toBe(false);
    expect(activeElsewhere.message).toBe(ENFORCEMENT_COPY.TRIAL_ACTIVE_ELSEWHERE);

    await app.prisma.trialGrant.updateMany({ where: { accountId: h1.id }, data: { status: 'CONSUMED' } });
    const consumed = await previewTrial(app.prisma, h2.id, 'VENDOR', 'swift-default', 'GY$20,000');
    expect(consumed.willTrial).toBe(false);
    expect(consumed.message).toContain('billing starts');
    expect(consumed.message).toContain('GY$20,000');

    // Preview is read-only: no enforcement rows, no grants were written.
    expect(await app.prisma.enforcementAction.count({ where: { accountId: h2.id } })).toBe(0);
  });
});

describe('scenario K — the appeal loop (Part 4)', () => {
  it('deny → appeal → overturn → FOUNDER_OVERRIDE exception → the law grants next time', async () => {
    const identity = new IdentityService(app.prisma);
    const subs = new SubscriptionService(app.prisma);
    const doc = `ID-${nanoid(8)}`;
    const h1 = await makeUser();
    const h2 = await makeUser();
    for (const h of [h1, h2]) {
      await identity.capture({ accountId: h.id, tenantId: 'swift-default', actorRole: 'VENDOR', type: 'ID_DOC_NUMBER', normalizedValue: normalizeDocNumber(doc), source: 'AI_ID_ANALYZER' });
    }
    await subs.startTrialForVendor((await makeVendorFor(h1.id)).id);

    // The denial leaves its explainable evidence row…
    const denied = await subs.startTrialForVendor((await makeVendorFor(h2.id)).id);
    expect(denied.status).toBe('ACTIVE'); // billed
    const row = await app.prisma.enforcementAction.findFirst({ where: { accountId: h2.id, level: 'DENY_TRIAL', reasonCode: 'TRIAL_ACTIVE_ELSEWHERE' } });
    expect(row).toBeTruthy();

    // …the human appeals ("it's my brother's shop, not mine")…
    const opened = await openAppeal(app.prisma, h2.id, 'This is a different business — my brother owns the other one.');
    expect(opened!.appeal).toBe('OPEN');

    // …the founder overturns → exception granted on the cluster…
    await resolveAppeal(app.prisma, opened!.id, 'admin-test', 'OVERTURNED', 'Verified: two different businesses.');
    const cluster = await identity.resolveCluster(h2.id);
    const exception = await app.prisma.exceptionGrant.findFirst({ where: { clusterId: cluster!, scope: 'FOUNDER_OVERRIDE' } });
    expect(exception).toBeTruthy();

    // …and the law honors the human on the next activation.
    const third = await subs.startTrialForVendor((await makeVendorFor(h2.id)).id);
    expect(third.status).toBe('TRIAL');

    const rate = await appealOverturnRate(app.prisma);
    expect(rate.overturned).toBeGreaterThanOrEqual(1);
    expect(rate.rate).toBeGreaterThan(0);
  });
});
