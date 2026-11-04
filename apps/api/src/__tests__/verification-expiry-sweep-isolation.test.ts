/**
 * [Row 209] One document never stops the daily expiry sweep.
 *
 * Before: any throw inside expireLapsedDocuments() (a lapsed row the document machine cannot
 * expire, a failed projection, a failed follow-up, a failed heal) ended the walk, so every other
 * lapsed document stayed valid, and the rest of the daily job (reminders, retention reaper,
 * licence sweep) never ran. Real database, real document-state trigger.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { socketPlugin } from '../plugins/socket';
import { VerificationService } from '../modules/verification/verification.service';
import { NotificationService } from '../modules/notification/notification.service';
import { getKycProvider } from '../providers/kyc/kyc-provider';
import { EXPIRABLE_DOC_STATES, ExpirySweepReport } from '../modules/verification/expiry-sweep-report';
import { DOC_STATES, LEGACY_STATUS_OF, RETIRED_DOC_STATES } from '../modules/verification/doc-state';
import { dueRenewalNotices } from '../modules/verification/renewal-schedule';

// The provider heal is a module function: a switchable failure, the real heal otherwise.
const heal = vi.hoisted(() => ({ fail: false }));
vi.mock('../modules/services/services.service', async (original) => {
  const actual = await original<typeof import('../modules/services/services.service')>();
  return {
    ...actual,
    reconcileProviderVerifications: async (...args: Parameters<typeof actual.reconcileProviderVerifications>) => {
      if (heal.fail) throw new Error('injected provider heal failure');
      return actual.reconcileProviderVerifications(...args);
    },
  };
});

let app: FastifyInstance;
let svc: VerificationService;
const marker = nanoid(6).toLowerCase();
const NUM = String(Date.now()).slice(-4);
const userIds: string[] = [];
let adminId = '';
let seq = 0;
const LAPSED = () => new Date(Date.now() - 60_000);

async function makeUser(role: 'MOVER' | 'VENDOR_OWNER') {
  seq += 1;
  const user = await app.prisma.user.create({
    data: {
      phone: `+59267${NUM}${String(seq).padStart(2, '0')}`,
      firstName: 'Sweep', lastName: `Iso${marker}${seq}`,
      roles: [role, 'CUSTOMER'] as never[], activeRole: role as never,
      isPhoneVerified: true, countryCode: 'GY',
    },
  });
  userIds.push(user.id);
  return user;
}

async function lapsedDoc(userId: string, role: 'MOVER' | 'VENDOR_OWNER', extra: Record<string, unknown> = {}) {
  return app.prisma.verificationDocument.create({
    data: {
      userId, role, docType: role === 'MOVER' ? 'gei_electrical_licence' : 'food_handler_permit',
      fileUrl: `test/${marker}/${nanoid(5)}`, status: 'APPROVED', expiresAt: LAPSED(), ...extra,
    } as never,
  });
}

const statusOf = async (id: string) => (await app.prisma.verificationDocument.findUniqueOrThrow({ where: { id } })).status;
const sweepNotices = async (since: Date) => (await app.prisma.notification.findMany({
  where: { userId: adminId, createdAt: { gte: since } },
})).filter((n) => (n.data as { kind?: string } | null)?.kind === 'ops_reaper_failed' && /expiry/i.test(n.title));

beforeAll(async () => {
  process.env['NODE_ENV'] = 'development';
  process.env['DATABASE_URL'] = process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift_test';
  process.env['REDIS_URL'] = process.env['REDIS_URL'] || 'redis://localhost:6382';
  app = Fastify({ logger: false });
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(socketPlugin);
  await app.ready();
  svc = new VerificationService(app.prisma, new NotificationService(app.prisma, app.io), getKycProvider());
  const admin = await app.prisma.user.create({
    data: {
      phone: `+59267${NUM}99`, firstName: 'Sweep', lastName: `Admin${marker}`,
      roles: ['SUPER_ADMIN', 'CUSTOMER'] as never[], activeRole: 'SUPER_ADMIN' as never,
      isPhoneVerified: true, countryCode: 'GY',
    },
  });
  adminId = admin.id; userIds.push(admin.id);
});

afterEach(() => { vi.restoreAllMocks(); });

afterAll(async () => {
  await app.prisma.notification.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.verificationDocument.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await app.close();
});

describe('[Row 209] the daily expiry sweep isolates every row', () => {
  it('a lapsed row the machine cannot expire is HELD; an ordinary lapsed row in the same run expires; ONE admin notice, counts only', async () => {
    const held = await makeUser('MOVER');
    const plain = await makeUser('MOVER');
    // APPROVED (not yet COMMITTED): the trigger refuses APPROVED -> EXPIRED with DOC_STATE_ILLEGAL.
    const stuck = await lapsedDoc(held.id, 'MOVER', { state: 'APPROVED' });
    const ordinary = await lapsedDoc(plain.id, 'MOVER');
    const since = new Date();

    await expect(svc.expireLapsedDocuments()).resolves.toBeGreaterThanOrEqual(1);

    expect(await statusOf(stuck.id)).toBe('APPROVED'); // held as it is, for a person
    expect(await statusOf(ordinary.id)).toBe('EXPIRED');
    const notices = await sweepNotices(since);
    expect(notices).toHaveLength(1);
    const text = `${notices[0]!.title} ${notices[0]!.body} ${JSON.stringify(notices[0]!.data)}`;
    expect(text).toMatch(/not_expirable=\d+/);
    for (const secret of [held.id, plain.id, stuck.id, ordinary.id, held.phone, held.lastName!, plain.phone]) {
      expect(text).not.toContain(secret);
    }
  });

  it('a row whose expiry transaction fails stays lapsed (retried next run) while the next row expires', async () => {
    const a = await makeUser('MOVER');
    const b = await makeUser('MOVER');
    const failing = await lapsedDoc(a.id, 'MOVER');
    const fine = await lapsedDoc(b.id, 'MOVER');
    const target = svc as unknown as { projectVendorActivation: (...args: unknown[]) => Promise<unknown> };
    const real = target.projectVendorActivation.bind(svc);
    vi.spyOn(target, 'projectVendorActivation').mockImplementation(async (tx: unknown, userId: unknown, ...rest: unknown[]) => {
      if (userId === a.id) throw new Error('injected projection failure');
      return real(tx, userId, ...rest);
    });
    const since = new Date();

    await expect(svc.expireLapsedDocuments()).resolves.toBeGreaterThanOrEqual(1);

    expect(await statusOf(failing.id)).toBe('APPROVED'); // rolled back, still lapsed
    expect(await statusOf(fine.id)).toBe('EXPIRED');
    const notices = await sweepNotices(since);
    expect(notices).toHaveLength(1);
    expect(notices[0]!.body).toMatch(/expiry_failed=\d+/);
    expect(notices[0]!.body).not.toContain('injected projection failure');

    vi.restoreAllMocks();
    await svc.expireLapsedDocuments(); // the next run retries it
    expect(await statusOf(failing.id)).toBe('EXPIRED');
  });

  it('a failed follow-up (listing suspension) is reported while both documents expire', async () => {
    const a = await makeUser('VENDOR_OWNER');
    const b = await makeUser('VENDOR_OWNER');
    const first = await lapsedDoc(a.id, 'VENDOR_OWNER');
    const second = await lapsedDoc(b.id, 'VENDOR_OWNER');
    const target = svc as unknown as { suspendListingsIfUnverified: (userId: string) => Promise<unknown> };
    const real = target.suspendListingsIfUnverified.bind(svc);
    const spy = vi.spyOn(target, 'suspendListingsIfUnverified').mockImplementation(async (userId: string) => {
      if (userId === a.id) throw new Error('injected listing failure');
      return real(userId);
    });
    const since = new Date();

    await expect(svc.expireLapsedDocuments()).resolves.toBeGreaterThanOrEqual(2);

    expect(await statusOf(first.id)).toBe('EXPIRED');
    expect(await statusOf(second.id)).toBe('EXPIRED');
    expect(spy.mock.calls.map(([u]) => u)).toEqual(expect.arrayContaining([a.id, b.id]));
    const notices = await sweepNotices(since);
    expect(notices).toHaveLength(1);
    expect(notices[0]!.body).toMatch(/effects_failed=\d+/);
    expect(notices[0]!.body, 'a follow-up is not retried: the notice says what that can mean').toContain('may still be online or listed');
  });

  it('a failed vendor heal never stops the expiry', async () => {
    const a = await makeUser('MOVER');
    const doc = await lapsedDoc(a.id, 'MOVER');
    const target = svc as unknown as { reconcileVendorActivations: () => Promise<unknown> };
    vi.spyOn(target, 'reconcileVendorActivations').mockRejectedValue(new Error('injected heal failure'));
    const since = new Date();

    await expect(svc.expireLapsedDocuments()).resolves.toBeGreaterThanOrEqual(1);

    expect(await statusOf(doc.id)).toBe('EXPIRED');
    const notices = await sweepNotices(since);
    expect(notices).toHaveLength(1);
    expect(notices[0]!.body).toMatch(/vendor_reconcile=1/);
  });

  it('a failed provider heal never stops the expiry', async () => {
    const a = await makeUser('MOVER');
    const doc = await lapsedDoc(a.id, 'MOVER');
    const since = new Date();
    heal.fail = true;
    try {
      await expect(svc.expireLapsedDocuments()).resolves.toBeGreaterThanOrEqual(1);
    } finally { heal.fail = false; }
    expect(await statusOf(doc.id)).toBe('EXPIRED');
    const notices = await sweepNotices(since);
    expect(notices).toHaveLength(1);
    expect(notices[0]!.body).toMatch(/provider_reconcile=1/);
    expect(notices[0]!.body).not.toContain('may still be online');
  });

  it('rows that expire cleanly add no failure to the run notice', async () => {
    const a = await makeUser('MOVER');
    const doc = await lapsedDoc(a.id, 'MOVER');
    const since = new Date();
    await svc.expireLapsedDocuments();
    expect(await statusOf(doc.id)).toBe('EXPIRED');
    const mine = (await sweepNotices(since));
    // Other suites' leftover rows may be held in a shared DB; a clean run of OUR rows adds no failure kinds.
    for (const n of mine) expect(n.body).not.toMatch(/expiry_failed|effects_failed|vendor_reconcile|provider_reconcile/);
  });

  // [FIXES-4] The sweep selected by the legacy status, and the machine leaves that status alone on a
  // copy a renewal replaced or a purge emptied: such a row can never expire, nobody can act on it,
  // and it told the admins so every day, one more with every renewal.
  describe('[FIXES-4] a retired copy is not a lapsed document', () => {
    const FAR = () => new Date(Date.now() + 200 * 86_400_000);
    const insert = (userId: string, expiresAt: Date) => app.prisma.verificationDocument.create({
      data: { userId, role: 'MOVER', docType: 'gei_electrical_licence', fileUrl: `test/${marker}/${nanoid(5)}`, status: 'APPROVED', expiresAt } as never,
    });
    /** A renewal through the database's own mechanism: a newer commit supersedes the older one. */
    async function renewed(oldExpiry: Date, newExpiry: Date) {
      const user = await makeUser('MOVER');
      const old = await insert(user.id, oldExpiry);
      const current = await insert(user.id, newExpiry);
      const row = await app.prisma.verificationDocument.findUniqueOrThrow({ where: { id: old.id } });
      expect(row).toMatchObject({ state: 'SUPERSEDED', status: 'APPROVED' });
      return { user, old, current };
    }
    const reported = (spy: { mock: { calls: unknown[][] } }, id: string) => spy.mock.calls.filter(([, documentId]) => documentId === id).map(([reason]) => reason);

    it('a renewal\'s old copy, past its expiry, is not held, not reported and not touched', async () => {
      const add = vi.spyOn(ExpirySweepReport.prototype, 'add');
      const { old, current } = await renewed(LAPSED(), FAR());
      await svc.expireLapsedDocuments();
      expect(reported(add, old.id)).toEqual([]);
      expect(await app.prisma.verificationDocument.findUniqueOrThrow({ where: { id: old.id } })).toMatchObject({ state: 'SUPERSEDED', status: 'APPROVED' });
      expect(await statusOf(current.id)).toBe('APPROVED');
    });

    it('a purged copy, past its expiry, is not held or reported either', async () => {
      const add = vi.spyOn(ExpirySweepReport.prototype, 'add');
      const user = await makeUser('MOVER');
      const doc = await lapsedDoc(user.id, 'MOVER');
      await app.prisma.verificationDocument.update({ where: { id: doc.id }, data: { state: 'PURGED', purgedAt: new Date() } as never });
      expect(await app.prisma.verificationDocument.findUniqueOrThrow({ where: { id: doc.id } })).toMatchObject({ state: 'PURGED', status: 'APPROVED' });
      await svc.expireLapsedDocuments();
      expect(reported(add, doc.id)).toEqual([]);
    });

    it('expiry is not weakened: the current copy of a renewal expires when it lapses', async () => {
      const { user, old } = await renewed(new Date(Date.now() - 120_000), FAR());
      const current = await insert(user.id, LAPSED());
      await expect(svc.expireLapsedDocuments()).resolves.toBeGreaterThanOrEqual(1);
      expect(await statusOf(current.id)).toBe('EXPIRED');
      expect((await app.prisma.verificationDocument.findUniqueOrThrow({ where: { id: old.id } })).state).toBe('SUPERSEDED');
    });

    it.each(['COMMITTED', 'REVIEW_QUEUED', 'IN_REVIEW', 'INFO_REQUESTED'] as const)('expiry is not weakened: a lapsed %s row still expires', async (state) => {
      const user = await makeUser('MOVER');
      const doc = await lapsedDoc(user.id, 'MOVER', state === 'COMMITTED' ? {} : { state, status: 'PENDING' });
      await expect(svc.expireLapsedDocuments()).resolves.toBeGreaterThanOrEqual(1);
      expect(await app.prisma.verificationDocument.findUniqueOrThrow({ where: { id: doc.id } })).toMatchObject({ state: 'EXPIRED', status: 'EXPIRED' });
    });

    it('a row with no state at all stays in the sweep: it is never silently skipped', async () => {
      const add = vi.spyOn(ExpirySweepReport.prototype, 'add');
      const user = await makeUser('MOVER');
      const doc = await lapsedDoc(user.id, 'MOVER');
      await app.prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica');
        await tx.$executeRaw`UPDATE verification_documents SET state = NULL WHERE id = ${doc.id}`;
      });
      await svc.expireLapsedDocuments();
      // the document machine has no edge from no state, so the row is reported for a person, as before
      expect(reported(add, doc.id)).toEqual(['expiry_failed']);
    });

    it('a stuck row a person can act on is still reported', async () => {
      const add = vi.spyOn(ExpirySweepReport.prototype, 'add');
      const user = await makeUser('MOVER');
      const stuck = await lapsedDoc(user.id, 'MOVER', { state: 'AUTO_APPROVED' });
      await svc.expireLapsedDocuments();
      expect(reported(add, stuck.id)).toEqual(['not_expirable']);
    });

    it('the retired states are exactly the ones whose legacy status the machine leaves alone, and none can expire', () => {
      expect([...RETIRED_DOC_STATES].sort()).toEqual(['PURGED', 'SUPERSEDED']);
      expect([...RETIRED_DOC_STATES].sort()).toEqual(DOC_STATES.filter((s) => LEGACY_STATUS_OF[s] === null && s !== 'LEGAL_HOLD').sort());
      for (const s of RETIRED_DOC_STATES) expect(EXPIRABLE_DOC_STATES.has(s)).toBe(false);
    });

    it('a renewal\'s old copy sends no "expires soon" notice; the current copy still does', async () => {
      const soon = new Date(Date.now() + 5 * 86_400_000);
      const { old, current } = await renewed(soon, new Date(soon.getTime() + 86_400_000));
      const due = (await dueRenewalNotices(app.prisma)).map((n) => n.documentId);
      expect(due).not.toContain(old.id);
      expect(due).toContain(current.id);
    });

    it('a revoked document sends no "expires soon" notice either: the status rule still stands beside the new one', async () => {
      const user = await makeUser('MOVER');
      const doc = await insert(user.id, new Date(Date.now() + 5 * 86_400_000));
      await app.prisma.verificationDocument.update({ where: { id: doc.id }, data: { state: 'REVOKED' } as never });
      expect(await app.prisma.verificationDocument.findUniqueOrThrow({ where: { id: doc.id } })).toMatchObject({ state: 'REVOKED', status: 'REJECTED' });
      expect((await dueRenewalNotices(app.prisma)).map((n) => n.documentId)).not.toContain(doc.id);
    });
  });

  it('the expirable states are exactly the document machine\'s', () => {
    expect([...EXPIRABLE_DOC_STATES].sort()).toEqual(['COMMITTED', 'INFO_REQUESTED', 'IN_REVIEW', 'REVIEW_QUEUED']);
    expect(EXPIRABLE_DOC_STATES.has('APPROVED')).toBe(false);
  });
});
