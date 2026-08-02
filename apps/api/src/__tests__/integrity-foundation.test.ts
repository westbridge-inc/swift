import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { nanoid } from 'nanoid';
import {
  normalizeDocNumber,
  normalizeEmail,
  normalizePhone,
  normalizeIpSubnet,
  normalizeNameDob,
  hashSignal,
} from '../modules/integrity/normalize';
import { IdentityService } from '../modules/integrity/identity.service';
import { TrialEntitlementService } from '../modules/integrity/trial-entitlement.service';
import { SubscriptionService } from '../modules/subscription/subscription.service';

// Trial-integrity foundation (spec Parts 2–3, test plan Part 11). The heart:
// the trial law — ONE trial per human per role per tenant — held by the
// identity graph, proven under the spec's named scenarios: A (same ID, fresh
// everything), E (debt cluster), G (retroactive payer discovery — firm, never
// a rug-pull), I (the concurrency race), and the hard-coded GUARDRAIL that
// SOFT signals can never merge clusters or deny anyone anything.

const prisma = new PrismaClient({ datasources: { db: { url: process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift_test' } } });
const identity = new IdentityService(prisma);
const trialLaw = new TrialEntitlementService(prisma);
const subscriptions = new SubscriptionService(prisma);

const userIds: string[] = [];
const vendorIds: string[] = [];
const ownerIds: string[] = [];
let seq = 0;
const phoneBase = 592_890_000_000 + Math.floor(Math.random() * 9_000_000);

async function makeUser(status: 'ACTIVE' | 'BANNED' = 'ACTIVE') {
  seq += 1;
  const u = await prisma.user.create({
    data: {
      phone: `+${phoneBase + seq}`, firstName: 'Integ', lastName: `U${seq}`,
      roles: ['VENDOR_OWNER', 'CUSTOMER'], activeRole: 'VENDOR_OWNER', isPhoneVerified: true, status,
    },
  });
  userIds.push(u.id);
  return u;
}

async function makeVendorFor(userId: string) {
  const owner = await prisma.vendorOwner.upsert({ where: { userId }, create: { userId }, update: {} });
  ownerIds.push(owner.id);
  const vendor = await prisma.vendor.create({
    data: {
      ownerId: owner.id,
      name: `Integrity Vendor ${seq}-${nanoid(4)}`, slug: `integrity-${nanoid(8).toLowerCase()}`,
      vendorType: 'RESTAURANT', phone: `+${phoneBase + 500_000 + seq}`,
      addressLine1: '1 Test Street', city: 'Georgetown', region: 'Demerara-Mahaica',
      latitude: 6.8, longitude: -58.15,
      status: 'ACTIVE', acceptingOrders: true, isVerified: true,
    },
  });
  vendorIds.push(vendor.id);
  return vendor;
}

const captureId = (userId: string, docNo: string) =>
  identity.capture({
    accountId: userId, tenantId: 'swift-default', actorRole: 'VENDOR',
    type: 'ID_DOC_NUMBER', normalizedValue: normalizeDocNumber(docNo), source: 'AI_ID_ANALYZER',
  });

beforeAll(async () => {
  await prisma.$connect();
  // CI preps the DB with `prisma db push`, which cannot see raw DDL — the
  // race-guard partial unique self-installs here, idempotently (the
  // established pattern; the migration remains prod's source of truth).
  await prisma.$executeRawUnsafe(
    `CREATE UNIQUE INDEX IF NOT EXISTS "trial_grants_one_active" ON "trial_grants" ("tenantId", "clusterId", "role") WHERE status = 'ACTIVE'`,
  );
});

afterAll(async () => {
  const clusters = await prisma.identityClusterMember.findMany({ where: { accountId: { in: userIds } }, select: { clusterId: true } });
  const clusterIds = [...new Set(clusters.map((c) => c.clusterId))];
  await prisma.enforcementAction.deleteMany({ where: { accountId: { in: userIds } } });
  await prisma.trialGrant.deleteMany({ where: { accountId: { in: userIds } } });
  await prisma.identityKey.deleteMany({ where: { accountId: { in: userIds } } });
  await prisma.identityClusterMember.deleteMany({ where: { accountId: { in: userIds } } });
  await prisma.exceptionGrant.deleteMany({ where: { clusterId: { in: clusterIds } } });
  await prisma.identityCluster.deleteMany({ where: { OR: [{ id: { in: clusterIds } }, { mergedIntoId: { in: clusterIds } }] } });
  await prisma.subscription.deleteMany({ where: { vendorId: { in: vendorIds } } });
  await prisma.vendor.deleteMany({ where: { id: { in: vendorIds } } });
  await prisma.vendorOwner.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await prisma.$disconnect();
});

describe('normalization (Part 11 matcher units, table-driven)', () => {
  it('doc numbers: spaces/dashes/case collapse to one value', () => {
    const forms = ['154-829-063', '154 829 063', '154829063', 'r-154829063'.toUpperCase().slice(2)];
    const hashes = new Set(forms.map((f) => hashSignal(normalizeDocNumber(f))));
    expect(hashes.size).toBe(1);
  });
  it('emails: dots and plus-aliases collapse; domains untouched', () => {
    expect(normalizeEmail('J.o.h.n+trial7@Gmail.com')).toBe('john@gmail.com');
    expect(normalizeEmail('john@g.mail.co')).toBe('john@g.mail.co');
  });
  it('phones: formatting collapses; hash is deterministic', () => {
    expect(normalizePhone('+592 600-1234')).toBe(normalizePhone('5926001234'));
    expect(hashSignal('x')).toBe(hashSignal('x'));
  });
  it('IPv4 collapses to /24; name+dob composes fuzzily', () => {
    expect(normalizeIpSubnet('190.83.44.129')).toBe('190.83.44.0/24');
    expect(normalizeNameDob('  Mohan   PERSAUD ', '1990-04-02T00:00:00Z')).toBe('mohan persaud|1990-04-02');
  });
});

describe('clustering (spec §2.3)', () => {
  it('a HARD match unions two accounts into one cluster with evidence', async () => {
    const a = await makeUser();
    const b = await makeUser();
    const doc = `ID-${nanoid(8)}`;
    await captureId(a.id, doc);
    const res = await captureId(b.id, doc);
    expect(res.merged).toBe(true);
    const [ca, cb] = [await identity.resolveCluster(a.id), await identity.resolveCluster(b.id)];
    expect(ca).toBe(cb);
    const member = await prisma.identityClusterMember.findUnique({ where: { accountId: b.id } });
    expect(JSON.stringify(member!.linkedVia)).toContain('ID_DOC_NUMBER'); // reconstructable evidence
  });

  it('GUARDRAIL: SOFT signals NEVER merge clusters — they only flag', async () => {
    const a = await makeUser();
    const b = await makeUser();
    for (const u of [a, b]) {
      await identity.capture({ accountId: u.id, tenantId: 'swift-default', actorRole: 'VENDOR', type: 'DEVICE', normalizedValue: 'shared-family-phone-1', source: 'DEVICE' });
      await identity.capture({ accountId: u.id, tenantId: 'swift-default', actorRole: 'VENDOR', type: 'IP_SUBNET', normalizedValue: '190.83.44.0/24', source: 'REQUEST_META' });
      await identity.capture({ accountId: u.id, tenantId: 'swift-default', actorRole: 'VENDOR', type: 'EMAIL', normalizedValue: 'cafe@shared.gy', source: 'SIGNUP' });
    }
    const [ca, cb] = [await identity.resolveCluster(a.id), await identity.resolveCluster(b.id)];
    // SOFT captures never even create cluster membership, let alone merge.
    expect(ca === null || cb === null || ca !== cb).toBe(true);
    // But the advisory surface sees the sharing — human eyes only.
    const advisories = await identity.softAdvisories(a.id);
    expect(advisories.some((x) => x.sharedWithAccountId === b.id)).toBe(true);
  });
});

describe('the trial law (spec §3 — scenarios A, E, G, I + churn)', () => {
  it('A: same ID behind a fresh account → first activates on TRIAL, second is born BILLED from day 1', async () => {
    const human1 = await makeUser();
    const human2 = await makeUser(); // "new" account, same physical human
    const doc = `ID-${nanoid(8)}`;
    await captureId(human1.id, doc);
    await captureId(human2.id, doc);

    const v1 = await makeVendorFor(human1.id);
    const sub1 = await subscriptions.startTrialForVendor(v1.id);
    expect(sub1.status).toBe('TRIAL');
    expect(sub1.isTrialActive).toBe(true);

    const v2 = await makeVendorFor(human2.id);
    const sub2 = await subscriptions.startTrialForVendor(v2.id);
    expect(sub2.status).toBe('ACTIVE'); // billed from day 1 — no second trial
    expect(sub2.isTrialActive).toBe(false);
    expect(sub2.nextBillingDate.getTime()).toBeLessThanOrEqual(Date.now() + 1000);

    const cluster = await identity.resolveCluster(human1.id);
    const grants = await prisma.trialGrant.findMany({ where: { clusterId: cluster!, role: 'VENDOR' } });
    expect(grants).toHaveLength(1); // ★ the law
  });

  it('I: two simultaneous activations of the same human → exactly ONE grant survives the race', async () => {
    const h1 = await makeUser();
    const h2 = await makeUser();
    const doc = `ID-${nanoid(8)}`;
    await captureId(h1.id, doc);
    await captureId(h2.id, doc);
    const [va, vb] = [await makeVendorFor(h1.id), await makeVendorFor(h2.id)];

    const [ra, rb] = await Promise.all([
      subscriptions.startTrialForVendor(va.id),
      subscriptions.startTrialForVendor(vb.id),
    ]);
    const cluster = await identity.resolveCluster(h1.id);
    const grants = await prisma.trialGrant.findMany({ where: { clusterId: cluster!, role: 'VENDOR' } });
    expect(grants).toHaveLength(1);
    const statuses = [ra.status, rb.status].sort();
    // One trial, one billed — or both billed if the decide/insert interleaving
    // was fully adversarial; NEVER two trials.
    expect(statuses.filter((s) => s === 'TRIAL').length).toBeLessThanOrEqual(1);
  });

  it('G: retroactive payer discovery mid-trials → earliest grant survives, later REVOKED with 48h notice, subscription untouched', async () => {
    const h1 = await makeUser();
    const h2 = await makeUser();
    const [v1, v2] = [await makeVendorFor(h1.id), await makeVendorFor(h2.id)];
    // Two apparently-separate humans, each legitimately on trial.
    const s1 = await subscriptions.startTrialForVendor(v1.id);
    const s2 = await subscriptions.startTrialForVendor(v2.id);
    expect(s1.status).toBe('TRIAL');
    expect(s2.status).toBe('TRIAL');

    // The money doesn't lie: the same MMG payer appears behind both.
    const payer = `59260${Math.floor(100000 + Math.random() * 899999)}`;
    await identity.capture({ accountId: h1.id, tenantId: 'swift-default', actorRole: 'VENDOR', type: 'MMG_PAYER', normalizedValue: payer, source: 'BILLING' });
    await identity.capture({ accountId: h2.id, tenantId: 'swift-default', actorRole: 'VENDOR', type: 'MMG_PAYER', normalizedValue: payer, source: 'BILLING' });

    const cluster = await identity.resolveCluster(h1.id);
    const grants = await prisma.trialGrant.findMany({ where: { clusterId: cluster!, role: 'VENDOR' }, orderBy: { startedAt: 'asc' } });
    expect(grants).toHaveLength(2);
    expect(grants[0]!.status).toBe('ACTIVE'); // the earliest survives
    expect(grants[1]!.status).toBe('REVOKED');
    expect(grants[1]!.statusReason).toBe('RETROACTIVE_DUPLICATE_48H_NOTICE');

    // Firm, never a rug-pull: the trial SUBSCRIPTION is not touched here —
    // billing begins on the notice schedule, not by instant suspension.
    const sub2After = await prisma.subscription.findUnique({ where: { id: s2.id } });
    expect(sub2After!.status).toBe('TRIAL');

    const action = await prisma.enforcementAction.findFirst({ where: { accountId: grants[1]!.accountId, reasonCode: 'RETROACTIVE_TRIAL_REVOKE' } });
    expect(action).toBeTruthy();
    expect(action!.decidedBy).toBe('SYSTEM');
  });

  it('E: a cluster carrying suspended debt → new activation gets NO trial and the reinstate-first evidence row', async () => {
    const h1 = await makeUser();
    const h2 = await makeUser();
    const doc = `ID-${nanoid(8)}`;
    await captureId(h1.id, doc);
    await captureId(h2.id, doc);
    const v1 = await makeVendorFor(h1.id);
    const s1 = await subscriptions.startTrialForVendor(v1.id);
    await prisma.subscription.update({ where: { id: s1.id }, data: { status: 'SUSPENDED' } });

    const v2 = await makeVendorFor(h2.id);
    const s2 = await subscriptions.startTrialForVendor(v2.id);
    expect(s2.status).toBe('ACTIVE'); // billed — the human settles the original first
    const action = await prisma.enforcementAction.findFirst({ where: { accountId: h2.id, reasonCode: 'DEBT_REINSTATE_FIRST' } });
    expect(action).toBeTruthy();
  });

  it('churn consumes the grant — returning never resets the clock', async () => {
    const h = await makeUser();
    const doc = `ID-${nanoid(8)}`;
    await captureId(h.id, doc);
    const v = await makeVendorFor(h.id);
    const s = await subscriptions.startTrialForVendor(v.id);
    expect(s.status).toBe('TRIAL');
    await trialLaw.consumeOnChurn(h.id, 'VENDOR', 'swift-default', 13);
    const decision = await trialLaw.decide(h.id, 'VENDOR', 'swift-default');
    expect(decision.grant).toBe(false);
    expect(decision.grant === false && decision.reason).toBe('TRIAL_CONSUMED');
  });

  it('F: a founder ExceptionGrant authorizes the additional trial (multi-location carve-out)', async () => {
    const h1 = await makeUser();
    const h2 = await makeUser();
    const doc = `ID-${nanoid(8)}`;
    await captureId(h1.id, doc);
    await captureId(h2.id, doc);
    const v1 = await makeVendorFor(h1.id);
    await subscriptions.startTrialForVendor(v1.id);

    const cluster = await identity.resolveCluster(h1.id);
    await prisma.exceptionGrant.create({
      data: { clusterId: cluster!, scope: 'MULTI_LOCATION_VENDOR', note: 'Founder approved trial-per-location', grantedBy: 'founder-test' },
    });

    const v2 = await makeVendorFor(h2.id);
    const s2 = await subscriptions.startTrialForVendor(v2.id);
    expect(s2.status).toBe('TRIAL'); // the exception, honored and referenced
    const exGrant = await prisma.trialGrant.findFirst({ where: { accountId: h2.id, statusReason: 'EXCEPTION_GRANT' } });
    expect(exGrant).toBeTruthy();
  });
});
