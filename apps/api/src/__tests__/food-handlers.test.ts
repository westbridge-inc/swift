/**
 * [FOOD-PERMIT · owner ruling 24 Oct 2026] A registered restaurant goes live on its owner's TICK, not on an uploaded
 * food handler's certificate:
 *
 *   "Everyone who handles food here holds a current food handler's certificate."
 *
 *  - The tick is stored server-side in the consent ledger (who, which store, when, the words' version and hash) and
 *    is REQUIRED: the activation projection never makes a registered restaurant live without it, nor does the console.
 *  - The certificate stays uploadable (optional), reviewed by a person and shown on the storefront while current.
 *  - A home cook (the self-declared tier) keeps the certificate REQUIRED and is never asked for the tick.
 *  - Old phone builds (9/11/12) cannot show the tick. Fail-safe both ways: (1) a store that has never been live — or
 *    is coming back from not being live — is HELD until the tick is given (web dashboard, or the updated app); the
 *    old app sees the step in its checklist, and uploading a file there is refused with words saying where to tick;
 *    (2) a restaurant that is ALREADY live is never taken down for it: it is told once, in its notices, to tick.
 *  - The prepared-food listing gate (CUISINE / DISH) accepts the tick in place of the certificate for a registered
 *    restaurant only.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { registerErrorHandler } from '../middleware/error-handler';
import { runWithTenant, runWithoutTenant } from '../plugins/tenant-context';
import { resetKeyProviderForTests } from '../providers/storage/envelope';
import { vendorRoutes } from '../modules/vendor/vendor.routes';
import { verificationRoutes } from '../modules/verification/verification.routes';
import { VerificationService } from '../modules/verification/verification.service';
import { NotificationService } from '../modules/notification/notification.service';
import { ManualReviewKycProvider } from '../providers/kyc/kyc-provider';
import { seedDocRegistry } from '../modules/verification/doc-registry';
import { gateVerdicts, vendorOwnerContext } from '../modules/verification/category-gate';
import { vendorActivationNext } from '../modules/admin/vendor-activation';
import { feePausePredicate } from '../modules/billing/mmg-pause';
import { FOOD_HANDLERS_TICK_V1 } from '../modules/vendor/food-handlers';
import { ownedVerificationFixture, signupSelfieFixture } from './helpers/verification-object';
import { reviewerTyped } from './helpers/reviewer-typed';
import { wordFreeTag } from './helpers/fixture-ids';

const TICK_TYPE = 'food_handler_attestation';
const NOTICE_KIND = 'vendor_needs_food_handler_tick';
const RUN = wordFreeTag(8);
const NUM = String(Date.now()).slice(-6);
const DAY = 86_400_000;
const system = <T>(fn: () => Promise<T>) => runWithoutTenant(fn, 'food-handlers-test');
let app: FastifyInstance;
let service: VerificationService;
let adminId = '';
const users: string[] = [];
let seq = 0;

beforeAll(async () => {
  vi.stubEnv('MASTER_KEK', Buffer.alloc(32, 7).toString('base64'));
  resetKeyProviderForTests();
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(prismaPlugin); await app.register(redisPlugin); await app.register(authPlugin); await app.register(socketPlugin);
  await app.register(vendorRoutes, { prefix: '/api/v1/vendor' });
  await app.register(verificationRoutes, { prefix: '/api/v1/verification' });
  await app.ready();
  await system(() => seedDocRegistry(app.prisma));
  service = new VerificationService(app.prisma, new NotificationService(app.prisma, app.io), new ManualReviewKycProvider());
  const admin = await system(() => app.prisma.user.create({ data: {
    phone: `+5928${NUM}00`, firstName: 'Food', lastName: 'Reviewer', roles: ['ADMIN'], activeRole: 'ADMIN', isPhoneVerified: true, admin: { create: { permissions: ['*'] } },
  } }));
  adminId = admin.id; users.push(admin.id);
});

afterAll(async () => {
  vi.unstubAllEnvs();
  resetKeyProviderForTests();
  if (!app) return;
  await system(async () => {
    const docs = (await app.prisma.verificationDocument.findMany({ where: { userId: { in: users } }, select: { id: true } })).map((d) => d.id);
    await app.prisma.reviewDecision.deleteMany({ where: { case: { submissionId: { in: docs } } } });
    await app.prisma.reviewCase.deleteMany({ where: { submissionId: { in: docs } } });
    await app.prisma.documentRecord.deleteMany({ where: { accountId: { in: users } } });
    await app.prisma.verificationDocument.deleteMany({ where: { userId: { in: users } } });
    await app.prisma.notification.deleteMany({ where: { userId: { in: users } } });
    const vendorIds = (await app.prisma.vendor.findMany({ where: { owner: { userId: { in: users } } }, select: { id: true } })).map((v) => v.id);
    await app.prisma.subscription.deleteMany({ where: { vendorId: { in: vendorIds } } });
    await app.prisma.vendor.deleteMany({ where: { id: { in: vendorIds } } });
    await app.prisma.vendorOwner.deleteMany({ where: { userId: { in: users } } });
    await app.prisma.user.deleteMany({ where: { id: { in: users } } });
  });
  await app.close();
});

type Owner = { userId: string; vendorId: string; token: string };

/** A restaurant owner with one store (registered unless told otherwise), never live yet unless told otherwise. */
async function restaurant(opts: { tier?: 'REGISTERED' | 'UNREGISTERED'; status?: 'PENDING_APPROVAL' | 'ACTIVE'; isVerified?: boolean; vendorType?: 'RESTAURANT' | 'SUPERMARKET'; name?: string } = {}): Promise<Owner> {
  seq += 1;
  const user = await system(() => app.prisma.user.create({ data: {
    phone: `+5928${NUM}${String(seq).padStart(2, '0')}`, firstName: 'Asha', lastName: `Cook${seq}`, roles: ['VENDOR_OWNER', 'CUSTOMER'], activeRole: 'VENDOR_OWNER',
    countryCode: 'GY', status: 'ACTIVE', isPhoneVerified: true,
  } }));
  users.push(user.id);
  await signupSelfieFixture(app.prisma, user.id);
  const vendorOwner = await runWithTenant('swift-default', () => app.prisma.vendorOwner.create({ data: { userId: user.id, vendors: { create: {
    name: opts.name ?? `Roti Hut ${seq}`, slug: `food-${RUN.toLowerCase()}-${seq}`, vendorType: opts.vendorType ?? 'RESTAURANT', tier: opts.tier ?? 'REGISTERED',
    phone: `+5928${NUM}9${seq}`, addressLine1: '1 Food Lane', city: 'Georgetown', region: 'Demerara-Mahaica',
    latitude: 6.8, longitude: -58.16, status: opts.status ?? 'PENDING_APPROVAL', isVerified: opts.isVerified ?? false, publicPhone: '+5926001234',
  } } }, include: { vendors: true } }));
  const token = app.jwt.sign({ userId: user.id, role: 'VENDOR_OWNER', jti: nanoid(8) });
  await runWithTenant('swift-default', () => app.prisma.session.create({ data: { userId: user.id, token, refreshToken: nanoid(24), deviceId: `food-${seq}`, deviceType: 'test', expiresAt: new Date(Date.now() + DAY) } }));
  return { userId: user.id, vendorId: vendorOwner.vendors[0]!.id, token };
}

const call = (method: 'GET' | 'POST', url: string, o: Owner, payload?: Record<string, unknown>) => app.inject({
  method, url, ...(payload ? { payload } : {}),
  headers: { authorization: `Bearer ${o.token}`, 'x-vendor-id': o.vendorId, ...(payload ? { 'content-type': 'application/json' } : {}) },
});
const tick = (o: Owner, body: Record<string, unknown> = { accept: true, attestationVersion: 'v1' }) => call('POST', '/api/v1/vendor/onboarding/food-handlers', o, body);
const statusOf = async (o: Owner, role = 'RESTAURANT') => (await call('GET', `/api/v1/verification/status?role=${role}`, o)).json().data;
const store = (o: Owner) => system(() => app.prisma.vendor.findUniqueOrThrow({ where: { id: o.vendorId }, select: { status: true, isVerified: true } }));
const notices = (o: Owner) => system(() => app.prisma.notification.findMany({ where: { userId: o.userId, data: { path: ['kind'], equals: NOTICE_KIND } } }));

/** Submit and approve (as a person) each document. */
async function approveAll(o: Owner, role: 'RESTAURANT' | 'SUPERMARKET', docTypes: readonly string[]) {
  for (const docType of docTypes) {
    const doc = await service.submitDocument(o.userId, role, docType, await ownedVerificationFixture(app.prisma, o.userId, `food-${docType}`), 'v1');
    await service.approveDocument(doc.id, adminId, new Date(Date.now() + 200 * DAY), undefined, reviewerTyped(docType, doc.id));
  }
}
const REGISTERED_DOCS = ['owner_national_id', 'business_registration', 'gra_restaurant_licence', 'storefront_photo'] as const;

describe('[FOOD-PERMIT] what a registered restaurant is asked for', () => {
  it('the certificate is optional (uploadable, reviewed); the tick is the step, with the owner’s words served', async () => {
    const o = await restaurant();
    const status = await statusOf(o);
    expect(status.checklist).not.toContain('food_handler_cert');
    expect(status.optional).toContain('food_handler_cert');
    // old phone builds read `checklist` / `missing` only: the tick shows there as a step still to do
    expect(status.checklist).toContain(TICK_TYPE);
    expect(status.missing).toContain(TICK_TYPE);
    expect(status.roleVerified).toBe(false);
    expect(status.foodHandlerAttestation).toEqual({
      version: 'v1', tick: FOOD_HANDLERS_TICK_V1,
      stores: [{ vendorId: o.vendorId, name: expect.any(String), attested: false }],
    });
    // the optional certificate is still taken, and a person decides it
    const doc = await service.submitDocument(o.userId, 'RESTAURANT', 'food_handler_cert', await ownedVerificationFixture(app.prisma, o.userId, 'food-optional-cert'), 'v1');
    expect(doc.status).toBe('PENDING');
  });

  it('a home cook (self-declared tier) keeps the certificate required and is never asked to tick', async () => {
    const o = await restaurant({ tier: 'UNREGISTERED' });
    const status = await statusOf(o);
    expect(status.checklist).toContain('food_handler_cert');
    expect(status.checklist).not.toContain(TICK_TYPE);
    expect(status.foodHandlerAttestation).toBeUndefined();
    const res = await tick(o);
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().error.code).toBe('FOOD_HANDLERS_NOT_APPLICABLE');
    expect(await system(() => app.prisma.consentRecord.count({ where: { subjectId: o.userId, documentType: TICK_TYPE } }))).toBe(0);
  });

  it('a supermarket is never asked to tick', async () => {
    const o = await restaurant({ vendorType: 'SUPERMARKET' });
    expect((await statusOf(o, 'SUPERMARKET')).checklist).not.toContain(TICK_TYPE);
    expect((await tick(o)).json().error.code).toBe('FOOD_HANDLERS_NOT_APPLICABLE');
  });
});

describe('[FOOD-PERMIT] a registered restaurant never goes live without the tick', () => {
  it('documents all approved: held, told once; the old app’s upload is refused with where to tick; the tick makes it live', async () => {
    const o = await restaurant();
    await approveAll(o, 'RESTAURANT', REGISTERED_DOCS);
    expect(await store(o)).toEqual({ status: 'PENDING_APPROVAL', isVerified: false });
    const told = await notices(o);
    expect(told).toHaveLength(1);
    expect(told[0]!.body).toContain(FOOD_HANDLERS_TICK_V1);
    expect(told[0]!.body).toMatch(/web dashboard/);
    // the belt runs again: still held, never told twice
    await service.reprojectVendorActivation(o.userId);
    expect(await store(o)).toEqual({ status: 'PENDING_APPROVAL', isVerified: false });
    expect(await notices(o)).toHaveLength(1);

    // the console refuses too
    const goLive = (await service.vendorGoLive(o.vendorId))!;
    expect(goLive.foodHandlers).toEqual({ required: true, attested: false });
    expect(goLive.ready).toBe(false);
    expect(vendorActivationNext({ status: 'PENDING_APPROVAL', suspensionSource: null, ownerAccountStatus: 'ACTIVE', subscription: null, feePause: feePausePredicate(false) }, goLive)).toBe('NEEDS_FOOD_HANDLER_TICK');

    // an old phone build shows the step as an upload card: a file is refused, with words saying where to tick
    const upload = await call('POST', '/api/v1/verification/documents', o, {
      role: 'RESTAURANT', docType: TICK_TYPE, fileUrl: await ownedVerificationFixture(app.prisma, o.userId, 'food-tick-file'), consent: true, privacyNoticeVersion: 'v1',
    });
    expect(upload.statusCode, upload.body).toBe(400);
    expect(upload.json().error.code).toBe('FOOD_HANDLERS_TICK_ONLY');
    expect(upload.json().error.message).toMatch(/web dashboard/);
    expect(await system(() => app.prisma.verificationDocument.count({ where: { userId: o.userId, docType: TICK_TYPE } }))).toBe(0);

    // other words, or no tick, are refused
    expect((await tick(o, { accept: true, attestationVersion: 'v0' })).statusCode).toBe(400);
    expect((await tick(o, { attestationVersion: 'v1' })).statusCode).toBe(400);

    const res = await tick(o);
    expect(res.statusCode, res.body).toBe(201);
    expect(await store(o)).toEqual({ status: 'ACTIVE', isVerified: true });
    const consent = await system(() => app.prisma.consentRecord.findFirstOrThrow({ where: { subjectId: o.userId, documentType: TICK_TYPE } }));
    expect(consent).toMatchObject({ subjectType: 'vendor_user', documentVersion: 'v1', action: 'granted', documentContentHash: createHash('sha256').update(FOOD_HANDLERS_TICK_V1, 'utf8').digest('hex') });
    expect(consent.evidence).toMatchObject({ vendorId: o.vendorId });
    const after = await statusOf(o);
    expect(after.checklist).not.toContain(TICK_TYPE);
    expect(after.missing).toEqual([]);
    expect(after.roleVerified).toBe(true);
    expect(after.foodHandlerAttestation.stores).toEqual([{ vendorId: o.vendorId, name: expect.any(String), attested: true }]);
    // a second tick changes nothing
    const again = await tick(o);
    expect(again.statusCode).toBe(200);
    expect(await system(() => app.prisma.consentRecord.count({ where: { subjectId: o.userId, documentType: TICK_TYPE } }))).toBe(1);
  });

  it('the tick is per store: ticking one restaurant never makes the owner’s other one live', async () => {
    const o = await restaurant();
    const ownerId = (await system(() => app.prisma.vendor.findUniqueOrThrow({ where: { id: o.vendorId }, select: { ownerId: true } }))).ownerId;
    const second = await runWithTenant('swift-default', () => app.prisma.vendor.create({ data: {
      ownerId, name: 'Second Kitchen', slug: `food-${RUN.toLowerCase()}-2nd-${seq}`, vendorType: 'RESTAURANT', phone: `+5928${NUM}8${seq}`, addressLine1: '2 Food Lane', city: 'Georgetown', region: 'Demerara-Mahaica',
      latitude: 6.8, longitude: -58.16, status: 'PENDING_APPROVAL', publicPhone: '+5926001235',
    } }));
    await approveAll(o, 'RESTAURANT', REGISTERED_DOCS);
    expect((await tick(o)).statusCode).toBe(201);
    const [first, other] = await system(() => Promise.all([o.vendorId, second.id].map((id) => app.prisma.vendor.findUniqueOrThrow({ where: { id }, select: { status: true } }))));
    expect([first!.status, other!.status]).toEqual(['ACTIVE', 'PENDING_APPROVAL']);
    const status = await statusOf(o);
    expect(status.missing).toContain(TICK_TYPE);
    expect(status.foodHandlerAttestation.stores).toEqual(expect.arrayContaining([
      { vendorId: o.vendorId, name: expect.any(String), attested: true },
      { vendorId: second.id, name: 'Second Kitchen', attested: false },
    ]));
  });

  it('a restaurant already live is never taken down for it — it is told once to tick', async () => {
    const o = await restaurant({ status: 'ACTIVE', isVerified: true });
    await approveAll(o, 'RESTAURANT', REGISTERED_DOCS);
    await service.reprojectVendorActivation(o.userId);
    expect(await store(o)).toEqual({ status: 'ACTIVE', isVerified: true });
    const told = await notices(o);
    expect(told).toHaveLength(1);
    expect(told[0]!.body).toContain(FOOD_HANDLERS_TICK_V1);
  });

  it('a live restaurant that lapsed comes back only with the tick', async () => {
    const o = await restaurant({ status: 'ACTIVE', isVerified: false });
    await approveAll(o, 'RESTAURANT', REGISTERED_DOCS);
    expect(await store(o)).toEqual({ status: 'ACTIVE', isVerified: false });
    expect(await notices(o)).toHaveLength(1);
    expect((await tick(o)).statusCode).toBe(201);
    expect(await store(o)).toEqual({ status: 'ACTIVE', isVerified: true });
  });
});

describe('[FOOD-PERMIT] the prepared-food listing gate', () => {
  const cuisine = { id: 'cat-cuisine', slug: 'caribbean', kind: 'CUISINE' as const };
  const handlerGate = async (o: Owner) => (await system(async () => gateVerdicts(app.prisma, await vendorOwnerContext(app.prisma, o.vendorId), [cuisine])))
    .find((v) => v.requiredDocType === 'food_handler_cert');

  it('a registered restaurant passes it with the tick in place of the certificate', async () => {
    const o = await restaurant();
    expect((await handlerGate(o))?.ok).toBe(false);
    expect((await tick(o)).statusCode).toBe(201);
    expect((await handlerGate(o))?.ok).toBe(true);
  });

  it('a home cook needs the certificate itself', async () => {
    const o = await restaurant({ tier: 'UNREGISTERED' });
    expect((await handlerGate(o))?.ok).toBe(false);
  });
});
