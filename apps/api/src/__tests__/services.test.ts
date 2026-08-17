import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import type { UserRole } from '@prisma/client';
import { beginRequestTenantContext, prismaPlugin, runWithoutTenant } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { servicesRoutes } from '../modules/services/services.routes';
import { verificationRoutes } from '../modules/verification/verification.routes';
import {
  canonicalServiceTrade,
  providerChecklist,
  refreshProviderVerification,
} from '../modules/services/services.service';
import { registerErrorHandler } from '../middleware/error-handler';

// ---------------------------------------------------------------------------
// Services (spec §4.6). Provider profile + qualification badge +
// "self-skilled" transparency; risk-tiered browse; the job lifecycle
// (request -> quote -> schedule -> complete) with two-way ratings; and the
// ID + police-clearance gate before a provider can take jobs.
// ---------------------------------------------------------------------------

const DAY = 24 * 60 * 60 * 1000;
let app: FastifyInstance;
const createdUserIds: string[] = [];
let seq = 0;
const TENANT_B = `services-tenant-${nanoid(6)}`;

async function makeUserWithSession(roles: UserRole[], activeRole: UserRole, tenantId = 'swift-default') {
  seq += 1;
  return runWithoutTenant(async () => {
    const user = await app.prisma.user.create({
      data: {
        phone: `+59200188${String(seq).padStart(2, '0')}`,
        firstName: 'Svc', lastName: `User${seq}`, roles, activeRole, tenantId,
        isPhoneVerified: true, selfieCapturedAt: new Date(),
        avatar: 'storage://test/provider-selfie.jpg',
        ...(roles.includes('CUSTOMER') && { customer: { create: {} } }),
      },
    });
    createdUserIds.push(user.id);
    const token = app.jwt.sign({ userId: user.id, role: activeRole, jti: nanoid(8) });
    await app.prisma.session.create({
      data: { userId: user.id, token, refreshToken: nanoid(48), deviceId: 'step21', deviceType: 'test', expiresAt: new Date(Date.now() + DAY) },
    });
    return { userId: user.id, token };
  });
}

async function approveProviderDocs(userId: string, docTypes = ['national_id', 'police_clearance']) {
  for (const docType of docTypes) {
    await app.prisma.verificationDocument.create({
      data: { userId, role: 'CUSTOMER', docType, fileUrl: `storage://t/${docType}.jpg`, status: 'APPROVED', consentAt: new Date(), privacyNoticeVersion: 'v1' },
    });
  }
}

/** A verified provider with a profile. */
async function makeVerifiedProvider(trade: string, tenantId = 'swift-default') {
  const u = await makeUserWithSession(['CUSTOMER'], 'CUSTOMER', tenantId);
  // Persist trade first so the canonical checklist includes any legal
  // extension (for example an electrician's GEI gate), then satisfy it.
  await inject('POST', '/api/v1/services/providers', { trade, bio: 'Experienced' }, u.token);
  await approveProviderDocs(u.userId, await providerChecklist(app.prisma, u.userId));
  const res = await inject('POST', '/api/v1/services/providers', { trade, bio: 'Experienced' }, u.token);
  const provider = res.json().data;
  return { ...u, providerId: provider.id, isVerified: provider.isVerified };
}

function inject(method: 'GET' | 'POST', url: string, payload?: unknown, token?: string) {
  return app.inject({
    method, url,
    ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
    headers: {
      ...(payload !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
  });
}

async function purgeFixtures() {
  await runWithoutTenant(async () => {
    const trackedIds = [...createdUserIds];
    const users = await app.prisma.user.findMany({ where: { phone: { startsWith: '+59200188' } }, select: { id: true } });
    const userIds = [...new Set([...trackedIds, ...users.map((user) => user.id)])];
    createdUserIds.length = 0;
    if (userIds.length === 0) return;
    const jobs = await app.prisma.serviceJob.findMany({
      where: { OR: [{ customerId: { in: userIds } }, { provider: { userId: { in: userIds } } }] },
      select: { id: true },
    });
    const jobIds = jobs.map((j) => j.id);
    await app.prisma.rating.deleteMany({ where: { OR: [{ raterId: { in: userIds } }, { orderId: { in: jobIds } }] } });
    await app.prisma.chatRoom.deleteMany({ where: { serviceJobId: { in: jobIds } } });
    await app.prisma.serviceJob.deleteMany({ where: { id: { in: jobIds } } });
    await app.prisma.serviceProvider.deleteMany({ where: { userId: { in: userIds } } });
    await app.prisma.verificationDocument.deleteMany({ where: { userId: { in: userIds } } });
    await app.prisma.auditLog.deleteMany({ where: { userId: { in: userIds } } });
    await app.prisma.user.deleteMany({ where: { id: { in: userIds } } });
  });
}

async function waitForBlockedProfileAuthorityLock(): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    const rows = await app.prisma.$queryRaw<Array<{ waiting: boolean }>>`
      SELECT EXISTS (
        SELECT 1 FROM pg_stat_activity
        WHERE state = 'active'
          AND wait_event_type = 'Lock'
          AND query LIKE '%service-provider-profile-authority%'
      ) AS waiting
    `;
    if (rows[0]?.waiting) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Provider profile change never reached the serialized User-row lock');
}

beforeAll(async () => {
  process.env['NODE_ENV'] = 'development';
  process.env['DATABASE_URL'] = process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift';
  process.env['REDIS_URL'] = process.env['REDIS_URL'] || 'redis://localhost:6382';

  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  app.addHook('onRequest', async () => { beginRequestTenantContext(); });
  await app.register(servicesRoutes, { prefix: '/api/v1/services' });
  await app.register(verificationRoutes, { prefix: '/api/v1/verification' });
  await app.ready();
  await runWithoutTenant(async () => {
    await app.prisma.tenant.upsert({
      where: { id: TENANT_B },
      update: {},
      create: { id: TENANT_B, name: 'Services Tenant B', slug: TENANT_B },
    });
  });
  await purgeFixtures();
});

afterAll(async () => {
  await purgeFixtures();
  await runWithoutTenant(async () => {
    await app.prisma.tenant.deleteMany({ where: { id: TENANT_B } });
  });
  await app.close();
});

describe('Services — provider verification + qualification badge', () => {
  it('authenticates, isolates, and idempotently upserts one profile per caller', async () => {
    const unauthenticated = await inject('POST', '/api/v1/services/providers', { trade: 'carpenter' });
    expect(unauthenticated.statusCode).toBe(401);

    const owner = await makeUserWithSession(['CUSTOMER'], 'CUSTOMER');
    const other = await makeUserWithSession(['CUSTOMER'], 'CUSTOMER');
    const [first, replay] = await Promise.all([
      inject('POST', '/api/v1/services/providers', { trade: 'carpenter', bio: 'Built-ins' }, owner.token),
      inject('POST', '/api/v1/services/providers', { trade: 'carpenter', bio: 'Built-ins' }, owner.token),
    ]);
    expect(first.statusCode).toBe(200);
    expect(replay.statusCode).toBe(200);
    expect(replay.json().data.id).toBe(first.json().data.id);
    expect(await app.prisma.serviceProvider.count({ where: { userId: owner.userId } })).toBe(1);

    const mine = await inject('GET', '/api/v1/services/providers/me', undefined, owner.token);
    expect(mine.json().data.id).toBe(first.json().data.id);
    const notMine = await inject('GET', '/api/v1/services/providers/me', undefined, other.token);
    expect(notMine.statusCode).toBe(404);
  });

  it('fails closed on the first electrician save until the trade-specific legal gate is met', async () => {
    const electrician = await makeUserWithSession(['CUSTOMER'], 'CUSTOMER');
    await approveProviderDocs(electrician.userId); // base documents only

    const created = await inject('POST', '/api/v1/services/providers', { trade: 'electrician' }, electrician.token);
    expect(created.statusCode).toBe(200);
    expect(created.json().data.isVerified).toBe(false);

    const status = await inject(
      'GET',
      '/api/v1/verification/status?role=SERVICE_PROVIDER',
      undefined,
      electrician.token,
    );
    expect(status.statusCode).toBe(200);
    expect(status.json().data.checklist).toContain('gei_electrical_licence');
    expect(status.json().data.missing).toContain('gei_electrical_licence');
  });

  it('is unverified without police clearance; verified with it', async () => {
    const u = await makeUserWithSession(['CUSTOMER'], 'CUSTOMER');
    // Only national_id approved — police clearance missing.
    await app.prisma.verificationDocument.create({
      data: { userId: u.userId, role: 'CUSTOMER', docType: 'national_id', fileUrl: 'storage://t/id.jpg', status: 'APPROVED', consentAt: new Date(), privacyNoticeVersion: 'v1' },
    });
    let res = await inject('POST', '/api/v1/services/providers', { trade: 'plumber' }, u.token);
    expect(res.json().data.isVerified).toBe(false);
    expect(res.json().data.selfSkilled).toBe(true);

    // Add police clearance → verified on next upsert.
    await app.prisma.verificationDocument.create({
      data: { userId: u.userId, role: 'CUSTOMER', docType: 'police_clearance', fileUrl: 'storage://t/pc.jpg', status: 'APPROVED', consentAt: new Date(), privacyNoticeVersion: 'v1' },
    });
    res = await inject('POST', '/api/v1/services/providers', { trade: 'plumber' }, u.token);
    expect(res.json().data.isVerified).toBe(true);
  });

  it('never turns an applicant-supplied GEI-shaped reference into a verified badge', async () => {
    const p = await makeVerifiedProvider('electrician');
    const qual = await inject('POST', '/api/v1/services/providers/qualifications', { type: 'GEI_LICENCE', referenceNumber: 'GEI-44821' }, p.token);
    expect(qual.statusCode).toBe(200);
    expect(qual.json().data.status).toBe('PENDING');
    expect(qual.json().data.trade).toBe('electrician');
    expect(qual.json().data.verifiedAt).toBeNull();

    const me = await inject('GET', '/api/v1/services/providers/me', undefined, p.token);
    expect(me.json().data.certified).toBe(false);
    expect(me.json().data.selfSkilled).toBe(true);
  });

  it('binds credentials to the canonical current trade and rejects a mismatched GEI claim', async () => {
    const plumber = await makeVerifiedProvider('plumber');
    const mismatch = await inject('POST', '/api/v1/services/providers/qualifications', {
      type: 'GEI_LICENCE',
      referenceNumber: 'GEI-PLUMBER-1',
    }, plumber.token);
    expect(mismatch.statusCode).toBe(400);
    expect(mismatch.json().error.code).toBe('QUALIFICATION_TRADE_MISMATCH');

    const pending = await inject('POST', '/api/v1/services/providers/qualifications', {
      type: 'CVQ',
      referenceNumber: 'CVQ-PLUMB-1',
    }, plumber.token);
    expect(pending.statusCode).toBe(200);
    expect(pending.json().data).toMatchObject({ trade: 'plumber', status: 'PENDING' });
  });

  it('returns the same qualification on a transport retry instead of minting duplicate badges', async () => {
    const p = await makeVerifiedProvider('plumber');
    const body = { type: 'CVQ', referenceNumber: 'CVQ-99182' };
    const [first, retry] = await Promise.all([
      inject('POST', '/api/v1/services/providers/qualifications', body, p.token),
      inject('POST', '/api/v1/services/providers/qualifications', body, p.token),
    ]);
    expect(first.statusCode).toBe(200);
    expect(retry.statusCode).toBe(200);
    expect(retry.json().data.id).toBe(first.json().data.id);
    expect(await app.prisma.serviceQualification.count({
      where: { providerId: p.providerId, trade: 'plumber', type: 'CVQ', referenceNumber: 'CVQ-99182' },
    })).toBe(1);
  });

  it('canonicalizes safe aliases and rejects unknown free text before it can bypass legal gates', async () => {
    expect(canonicalServiceTrade('Electrical contractor')).toBe('electrician');
    expect(canonicalServiceTrade('electrical')).toBe('electrician');
    expect(canonicalServiceTrade('ELECTRICIAN')).toBe('electrician');

    const provider = await makeUserWithSession(['CUSTOMER'], 'CUSTOMER');
    await approveProviderDocs(provider.userId);
    for (const alias of ['Electrical contractor', 'electrical', 'electrician']) {
      const saved = await inject('POST', '/api/v1/services/providers', { trade: alias }, provider.token);
      expect(saved.statusCode).toBe(200);
      expect(saved.json().data).toMatchObject({ trade: 'electrician', isVerified: false });
    }
    const unknown = await inject('POST', '/api/v1/services/providers', { trade: 'electrician-but-no-licence-needed' }, provider.token);
    expect(unknown.statusCode).toBe(400);
    expect(unknown.json().error.code).toBe('UNKNOWN_SERVICE_TRADE');
  });

  it('does not carry a trusted badge across a later trade change', async () => {
    const provider = await makeVerifiedProvider('plumber');
    const submitted = await inject('POST', '/api/v1/services/providers/qualifications', {
      type: 'CVQ',
      referenceNumber: 'CVQ-BOUND-PLUMB',
    }, provider.token);
    await app.prisma.serviceQualification.update({
      where: { id: submitted.json().data.id },
      data: { status: 'VERIFIED', verifiedAt: new Date() },
    });
    let me = await inject('GET', '/api/v1/services/providers/me', undefined, provider.token);
    expect(me.json().data.certified).toBe(true);

    const changed = await inject('POST', '/api/v1/services/providers', { trade: 'carpenter' }, provider.token);
    expect(changed.statusCode).toBe(200);
    me = await inject('GET', '/api/v1/services/providers/me', undefined, provider.token);
    expect(me.json().data).toMatchObject({ trade: 'carpenter', certified: false, selfSkilled: true });
    expect(me.json().data.qualifications[0]).toMatchObject({ trade: 'plumber', status: 'VERIFIED' });
  });

  it('runs customer → provider profile → canonical checklist → KYC approval → public listability', async () => {
    const provider = await makeUserWithSession(['CUSTOMER'], 'CUSTOMER');
    const customer = await makeUserWithSession(['CUSTOMER'], 'CUSTOMER');

    const profile = await inject('POST', '/api/v1/services/providers', {
      trade: 'mason',
      bio: 'Residential block work',
    }, provider.token);
    expect(profile.statusCode).toBe(200);
    expect(profile.json().data.isVerified).toBe(false);

    const before = await inject(
      'GET',
      '/api/v1/verification/status?role=SERVICE_PROVIDER',
      undefined,
      provider.token,
    );
    expect(before.statusCode).toBe(200);
    expect(before.json().data.checklist).toEqual(['national_id', 'police_clearance']);

    for (const docType of before.json().data.checklist as string[]) {
      const submitted = await inject('POST', '/api/v1/verification/documents', {
        role: 'SERVICE_PROVIDER',
        docType,
        fileUrl: `storage://test/auto-approve-${docType}.jpg`,
        consent: true,
        privacyNoticeVersion: 'v1',
      }, provider.token);
      expect(submitted.statusCode).toBe(201);
      expect(submitted.json().data.status).toBe('APPROVED');
    }

    const after = await inject('GET', '/api/v1/services/providers/me', undefined, provider.token);
    expect(after.statusCode).toBe(200);
    expect(after.json().data.isVerified).toBe(true);

    const publicList = await inject('GET', '/api/v1/services/providers?trade=mason', undefined, customer.token);
    expect(publicList.statusCode).toBe(200);
    expect(publicList.json().data.providers.map((row: { id: string }) => row.id))
      .toContain(profile.json().data.id);
  });

  it('serializes verification refresh against a carpenter → electrician trade change', async () => {
    const provider = await makeVerifiedProvider('carpenter');
    const customer = await makeUserWithSession(['CUSTOMER'], 'CUSTOMER');
    await app.prisma.serviceProvider.update({
      where: { id: provider.providerId },
      data: { isVerified: false },
    });

    let releaseSnapshot!: () => void;
    const snapshotRelease = new Promise<void>((resolve) => { releaseSnapshot = resolve; });
    let observeSnapshot!: (value: { persisted: boolean; recomputed: boolean }) => void;
    const snapshotObserved = new Promise<{ persisted: boolean; recomputed: boolean }>((resolve) => { observeSnapshot = resolve; });

    const refresh = refreshProviderVerification(app.prisma, provider.userId, {
      afterSnapshot: async ({ persisted, recomputed }) => {
        observeSnapshot({ persisted, recomputed });
        await snapshotRelease;
      },
    });
    expect(await snapshotObserved).toEqual({ persisted: false, recomputed: true });

    let profileSettled = false;
    const profileChange = inject('POST', '/api/v1/services/providers', { trade: 'electrician' }, provider.token)
      .then((response) => {
        profileSettled = true;
        return response;
      });

    let lockWaitError: unknown;
    try {
      await waitForBlockedProfileAuthorityLock();
      expect(profileSettled).toBe(false);
    } catch (error) {
      lockWaitError = error;
    } finally {
      releaseSnapshot();
    }

    const [, changed] = await Promise.all([refresh, profileChange]);
    if (lockWaitError) throw lockWaitError;
    expect(changed.statusCode).toBe(200);
    expect(changed.json().data.trade).toBe('electrician');
    expect(changed.json().data.isVerified).toBe(false);

    const persisted = await app.prisma.serviceProvider.findUniqueOrThrow({ where: { id: provider.providerId } });
    expect(persisted.trade).toBe('electrician');
    expect(persisted.isVerified).toBe(false);
    const publicList = await inject('GET', '/api/v1/services/providers?trade=electrician', undefined, customer.token);
    expect(publicList.json().data.providers.map((row: { id: string }) => row.id))
      .not.toContain(provider.providerId);
  });
});

describe('Services — risk-tiered browse', () => {
  it('keeps the browse contract explicit: trade is required and unknown trades fail closed', async () => {
    const missing = await inject('GET', '/api/v1/services/providers');
    expect(missing.statusCode).toBe(400);
    const unknown = await inject('GET', '/api/v1/services/providers?trade=anything-goes');
    expect(unknown.statusCode).toBe(400);
    expect(unknown.json().error.code).toBe('UNKNOWN_SERVICE_TRADE');
  });

  it('bounds anonymous pages at 50 and uses a stable opaque tenant/trade-bound cursor', async () => {
    const providers = await Promise.all([
      makeVerifiedProvider('tutor'),
      makeVerifiedProvider('tutoring'),
      makeVerifiedProvider('Tutor'),
    ]);
    const oversized = await inject('GET', '/api/v1/services/providers?trade=tutor&limit=51');
    expect(oversized.statusCode).toBe(400);

    const first = await inject('GET', '/api/v1/services/providers?trade=tutor&limit=2');
    expect(first.statusCode).toBe(200);
    const firstData = first.json().data;
    expect(firstData.providers).toHaveLength(2);
    expect(firstData.page.limit).toBe(2);
    expect(firstData.page.nextCursor).toEqual(expect.any(String));
    expect(firstData.page.nextCursor).not.toContain(providers[0]!.providerId);

    const replay = await inject('GET', '/api/v1/services/providers?trade=tutoring&limit=2');
    expect(replay.json().data.page.nextCursor).toBe(firstData.page.nextCursor);
    expect(replay.json().data.providers.map((row: { id: string }) => row.id))
      .toEqual(firstData.providers.map((row: { id: string }) => row.id));

    const cursor = encodeURIComponent(firstData.page.nextCursor);
    const second = await inject('GET', `/api/v1/services/providers?trade=tutor&limit=2&cursor=${cursor}`);
    expect(second.statusCode).toBe(200);
    expect(second.json().data.providers).toHaveLength(1);
    const allIds = [
      ...firstData.providers.map((row: { id: string }) => row.id),
      ...second.json().data.providers.map((row: { id: string }) => row.id),
    ];
    expect(new Set(allIds)).toEqual(new Set(providers.map((provider) => provider.providerId)));

    // Node accepts padded input in base64url mode. Appending '=' therefore
    // decodes to the same HMAC bytes unless the route rejects non-canonical
    // encodings before its timing-safe comparison.
    const tampered = `${firstData.page.nextCursor}=`;
    expect((await inject('GET', `/api/v1/services/providers?trade=tutor&limit=2&cursor=${encodeURIComponent(tampered)}`)).statusCode)
      .toBe(400);
    expect((await inject('GET', `/api/v1/services/providers?trade=mason&limit=2&cursor=${cursor}`)).statusCode)
      .toBe(400);
  });

  it('marks high-risk trades and recommends a licensed provider', async () => {
    const p = await makeVerifiedProvider('electrician');
    const submitted = await inject('POST', '/api/v1/services/providers/qualifications', { type: 'GEI_LICENCE', referenceNumber: 'GEI-90011' }, p.token);
    await app.prisma.serviceQualification.update({
      where: { id: submitted.json().data.id },
      data: { status: 'VERIFIED', verifiedAt: new Date() },
    }); // trusted-review authority is emulated directly; applicants cannot do this

    const customer = await makeUserWithSession(['CUSTOMER'], 'CUSTOMER');
    const res = await inject('GET', '/api/v1/services/providers?trade=electrician', undefined, customer.token);
    expect(res.statusCode).toBe(200);
    expect(res.json().data.riskTier).toBe('HIGH');
    expect(res.json().data.guidance).toMatch(/licensed|certified/i);
    expect(res.json().data.providers.length).toBeGreaterThanOrEqual(1);
    expect(res.json().data.providers[0].certified).toBe(true); // licensed listed first
  });

  it('the verified-first promise holds mechanically: unverified never list, a CLAIM is not a badge, real certs outrank ratings', async () => {
    // Isolated trade so the electrician rows above can't blur the ordering.
    const trade = 'plumbing';

    // 1. A provider with NO approved docs — must never appear to customers.
    const ghost = await makeUserWithSession(['CUSTOMER'], 'CUSTOMER');
    const ghostRes = await inject('POST', '/api/v1/services/providers', { trade, bio: 'No docs yet' }, ghost.token);
    const ghostId = ghostRes.json().data?.id;

    // 2. A verified provider who merely CLAIMS a certificate (non-checkable
    //    type → PENDING) and carries a stellar rating.
    const claimed = await makeVerifiedProvider(trade);
    await inject('POST', '/api/v1/services/providers/qualifications', { type: 'CVQ', referenceNumber: 'self-said-so' }, claimed.token);
    await app.prisma.serviceProvider.update({ where: { id: claimed.providerId }, data: { averageRating: 5, totalRatings: 40 } });

    // 3. A genuinely certified provider (registry-checkable licence) with a
    //    LOWER rating than the claimer.
    const certified = await makeVerifiedProvider(trade);
    const submitted = await inject('POST', '/api/v1/services/providers/qualifications', { type: 'CVQ', referenceNumber: 'CVQ-55021' }, certified.token);
    await app.prisma.serviceQualification.update({
      where: { id: submitted.json().data.id },
      data: { status: 'VERIFIED', verifiedAt: new Date() },
    }); // emulate an audited trusted reviewer; no applicant endpoint can set this
    await app.prisma.serviceProvider.update({ where: { id: certified.providerId }, data: { averageRating: 4.2, totalRatings: 12 } });

    const customer = await makeUserWithSession(['CUSTOMER'], 'CUSTOMER');
    const res = await inject('GET', `/api/v1/services/providers?trade=${trade}`, undefined, customer.token);
    expect(res.statusCode).toBe(200);
    const list = res.json().data.providers as { id: string; certified: boolean }[];

    // Unverified provider is invisible — not last, INVISIBLE.
    expect(list.some((p) => p.id === ghostId)).toBe(false);
    // The real certificate leads even against a higher rating…
    expect(list[0]?.id).toBe(certified.providerId);
    expect(list[0]?.certified).toBe(true);
    // …and the self-claimed certificate earns no badge and no priority.
    const claimedRow = list.find((p) => p.id === claimed.providerId);
    expect(claimedRow?.certified).toBe(false);
    expect(list.findIndex((p) => p.id === claimed.providerId)).toBeGreaterThan(0);
  });
});

describe('Services — job lifecycle + two-way rating', () => {
  it('keeps provider discovery and hiring inside the authenticated tenant', async () => {
    const providerA = await makeVerifiedProvider('carpenter');
    const providerB = await makeVerifiedProvider('carpenter', TENANT_B);
    const customerA = await makeUserWithSession(['CUSTOMER'], 'CUSTOMER');
    const customerB = await makeUserWithSession(['CUSTOMER'], 'CUSTOMER', TENANT_B);

    const guestBrowse = await inject('GET', '/api/v1/services/providers?trade=carpenter');
    expect(guestBrowse.statusCode).toBe(200);
    const guestIds = guestBrowse.json().data.providers.map((row: { id: string }) => row.id) as string[];
    expect(guestIds).toContain(providerA.providerId);
    expect(guestIds).not.toContain(providerB.providerId);

    const guestCannotChooseTenant = await inject(
      'GET',
      `/api/v1/services/providers?trade=carpenter&tenantId=${TENANT_B}`,
    );
    expect(guestCannotChooseTenant.statusCode).toBe(200);
    const injectedTenantIds = guestCannotChooseTenant.json().data.providers
      .map((row: { id: string }) => row.id) as string[];
    expect(injectedTenantIds).toContain(providerA.providerId);
    expect(injectedTenantIds).not.toContain(providerB.providerId);

    const browseA = await inject('GET', '/api/v1/services/providers?trade=carpenter', undefined, customerA.token);
    expect(browseA.statusCode).toBe(200);
    const tenantAIds = browseA.json().data.providers.map((row: { id: string }) => row.id) as string[];
    expect(tenantAIds).toContain(providerA.providerId);
    expect(tenantAIds).not.toContain(providerB.providerId);

    const browseB = await inject('GET', '/api/v1/services/providers?trade=carpenter', undefined, customerB.token);
    expect(browseB.statusCode).toBe(200);
    const tenantBIds = browseB.json().data.providers.map((row: { id: string }) => row.id) as string[];
    expect(tenantBIds).toContain(providerB.providerId);
    expect(tenantBIds).not.toContain(providerA.providerId);

    const crossTenantHire = await inject('POST', '/api/v1/services/jobs', {
      providerId: providerB.providerId,
      description: 'Build tenant A a custom kitchen cabinet.',
    }, customerA.token);
    expect(crossTenantHire.statusCode).toBe(404);
    expect(crossTenantHire.json().error.code).toBe('NOT_FOUND');

    const guestHire = await inject('POST', '/api/v1/services/jobs', {
      providerId: providerA.providerId,
      description: 'A guest must sign in before hiring this provider.',
    });
    expect(guestHire.statusCode).toBe(401);

    const sameTenantHire = await inject('POST', '/api/v1/services/jobs', {
      providerId: providerB.providerId,
      description: 'Build tenant B a custom kitchen cabinet.',
    }, customerB.token);
    expect(sameTenantHire.statusCode).toBe(201);
    expect(sameTenantHire.json().data.providerId).toBe(providerB.providerId);
  });

  it('runs request → quote → schedule → complete → both parties rate', async () => {
    const provider = await makeVerifiedProvider('carpenter');
    const customer = await makeUserWithSession(['CUSTOMER'], 'CUSTOMER');

    const created = await inject('POST', '/api/v1/services/jobs', {
      providerId: provider.providerId,
      description: 'Build a set of kitchen shelves, photos attached.',
    }, customer.token);
    expect(created.statusCode).toBe(201);
    const jobId = created.json().data.id;
    expect(created.json().data.status).toBe('REQUESTED');
    expect(created.json().data.chatRoomId).toBeTruthy(); // quote-via-chat room opened

    const quoted = await inject('POST', `/api/v1/services/jobs/${jobId}/quote`, { amount: 15000 }, provider.token);
    expect(quoted.json().data.status).toBe('QUOTED');
    expect(Number(quoted.json().data.quoteAmount)).toBe(15000);

    const scheduled = await inject('POST', `/api/v1/services/jobs/${jobId}/schedule`, { scheduledFor: new Date(Date.now() + 2 * DAY).toISOString() }, customer.token);
    expect(scheduled.json().data.status).toBe('SCHEDULED');

    const completed = await inject('POST', `/api/v1/services/jobs/${jobId}/complete`, {}, provider.token);
    expect(completed.json().data.status).toBe('COMPLETED');

    // Two-way ratings.
    const custRates = await inject('POST', `/api/v1/services/jobs/${jobId}/rate`, { score: 5, comment: 'Excellent work' }, customer.token);
    expect(custRates.json().data.type).toBe('CUSTOMER_TO_PROVIDER');
    const provRates = await inject('POST', `/api/v1/services/jobs/${jobId}/rate`, { score: 5 }, provider.token);
    expect(provRates.json().data.type).toBe('PROVIDER_TO_CUSTOMER');

    const updated = await app.prisma.serviceProvider.findUniqueOrThrow({ where: { id: provider.providerId } });
    expect(updated.totalRatings).toBe(1);
    expect(updated.averageRating).toBe(5);
  });

  it('blocks hiring an unverified provider', async () => {
    const unverifiedUser = await makeUserWithSession(['CUSTOMER'], 'CUSTOMER');
    const prof = await inject('POST', '/api/v1/services/providers', { trade: 'electrician' }, unverifiedUser.token);
    expect(prof.json().data.isVerified).toBe(false);

    const customer = await makeUserWithSession(['CUSTOMER'], 'CUSTOMER');
    const res = await inject('POST', '/api/v1/services/jobs', {
      providerId: prof.json().data.id,
      description: 'Rewire the whole house please, urgent job.',
    }, customer.token);
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('PROVIDER_NOT_VERIFIED');
  });

  it('a provider whose evidence lapses after the request cannot quote or confirm new work [STRAND-8]', async () => {
    const provider = await makeVerifiedProvider('carpenter');
    const customer = await makeUserWithSession(['CUSTOMER'], 'CUSTOMER');
    const created = await inject('POST', '/api/v1/services/jobs', {
      providerId: provider.providerId,
      description: 'Fit three interior doors with new hinges please.',
    }, customer.token);
    expect(created.statusCode).toBe(201);
    const jobId = created.json().data.id;

    // Between REQUESTED and the quote, the provider's checklist evidence
    // expires (the sweep may not have run yet — the timestamp itself decides).
    await app.prisma.verificationDocument.updateMany({
      where: { userId: provider.userId, status: 'APPROVED' },
      data: { expiresAt: new Date(Date.now() - 60_000) },
    });

    const quote = await inject('POST', `/api/v1/services/jobs/${jobId}/quote`, { amount: 12000 }, provider.token);
    expect(quote.statusCode).toBe(409);
    expect(quote.json().error.code).toBe('PROVIDER_NOT_VERIFIED');

    // Renewal restores the authority and the SAME job can proceed.
    await app.prisma.verificationDocument.updateMany({
      where: { userId: provider.userId },
      data: { expiresAt: new Date(Date.now() + 365 * 24 * 3600 * 1000) },
    });
    const quoteOk = await inject('POST', `/api/v1/services/jobs/${jobId}/quote`, { amount: 12000 }, provider.token);
    expect(quoteOk.statusCode).toBe(200);
    const scheduled = await inject('POST', `/api/v1/services/jobs/${jobId}/schedule`, { scheduledFor: new Date(Date.now() + 2 * DAY).toISOString() }, customer.token);
    expect(scheduled.statusCode).toBe(200);

    // Lapse again before slot confirmation — the last acceptance gate holds too.
    await app.prisma.verificationDocument.updateMany({
      where: { userId: provider.userId },
      data: { expiresAt: new Date(Date.now() - 60_000) },
    });
    const confirm = await inject('POST', `/api/v1/services/jobs/${jobId}/confirm`, {}, provider.token);
    expect(confirm.statusCode).toBe(409);
    expect(confirm.json().error.code).toBe('PROVIDER_NOT_VERIFIED');
  });
});
