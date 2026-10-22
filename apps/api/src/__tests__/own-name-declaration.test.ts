/**
 * [ROLE-DOCS · owner ruling 21 Oct 2026] "I trade under my own name" in place of a business registration — ONLY where
 * Guyana law makes registration unnecessary: Business Names (Registration) Act, Cap. 90:05, s.3(b) — one person whose
 * business name is their true surname "without any addition other than his true forenames or the initials thereof"
 * need not register; s.3(c) — unless they changed their name (other than by marriage). (vendor/own-name.ts)
 *
 *  - The sign-up asks the question first; a name that clearly is not the owner's own is refused before a store exists.
 *  - The owner signs the versioned words (consent ledger) and Swift files them as the `own_name_declaration` document.
 *  - A person approves it only after checking the name against the owner's ID (ownNameConfirmed), never by default.
 *  - The store's checklist then asks for the declaration INSTEAD of the business registration, and it goes live on it.
 *  - The name a person checked cannot be changed in the app; the owner can switch back to a business registration.
 *  - A service business (never asked for a registration) and a company never use this path.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
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
import { partnerRoutes } from '../modules/partner/partner.routes';
import { OWN_NAME_CONSENT_TYPE, OWN_NAME_DECLARATION_V1, storeNameIsOwnName } from '../modules/vendor/own-name';
import { VerificationService } from '../modules/verification/verification.service';
import { NotificationService } from '../modules/notification/notification.service';
import { ManualReviewKycProvider, SandboxKycProvider } from '../providers/kyc/kyc-provider';
import { reviewerTypedFields } from '../modules/verification/identity-signal-policy';
import { DEFAULT_DOCUMENT_CHECKLISTS } from '../modules/ops/platform-config';
import { ALWAYS_REVIEW_LEGACY_CODES, OWN_NAME_DOC_TYPE, seedDocRegistry } from '../modules/verification/doc-registry';
import { ownedVerificationFixture, signupSelfieFixture } from './helpers/verification-object';
import { wordFreeTag } from './helpers/fixture-ids';

// The phone's and the site's copies are read as TEXT: an API test cannot import another app's source (tsc rootDir).
const ROOT = join(process.cwd(), '../..');
function wordsIn(file: string, name: string): string {
  const m = new RegExp(`export const ${name} = \`([^\`]*)\`;`).exec(readFileSync(join(ROOT, file), 'utf8'));
  if (!m) throw new Error(`${name} not found in ${file}`);
  return m[1]!;
}
const MOBILE_WORDS = wordsIn('apps/mobile/src/lib/ownNameCopy.ts', 'OWN_NAME_DECLARATION_V1');
const WEB_WORDS = wordsIn('apps/web/src/lib/own-name-copy.ts', 'OWN_NAME_DECLARATION_WEB');

const RUN = wordFreeTag(8);
const NUM = String(Date.now()).slice(-6);
const DAY = 86_400_000;
const system = <T>(fn: () => Promise<T>) => runWithoutTenant(fn, 'own-name-declaration-test');
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
  await app.register(partnerRoutes, { prefix: '/api/v1/partner' });
  await app.ready();
  await system(() => seedDocRegistry(app.prisma));
  service = new VerificationService(app.prisma, new NotificationService(app.prisma, app.io), new ManualReviewKycProvider());
  const admin = await system(() => app.prisma.user.create({ data: {
    phone: `+5928${NUM}00`, firstName: 'Own', lastName: 'Reviewer', roles: ['ADMIN'], activeRole: 'ADMIN', isPhoneVerified: true, admin: { create: { permissions: ['*'] } },
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
    await app.prisma.encryptedObject.deleteMany({ where: { createdBy: { in: users } } });
    await app.prisma.notification.deleteMany({ where: { userId: { in: users } } });
    await app.prisma.vendor.deleteMany({ where: { owner: { userId: { in: users } } } });
    await app.prisma.vendorOwner.deleteMany({ where: { userId: { in: users } } });
    await app.prisma.user.deleteMany({ where: { id: { in: users } } });
  });
  await app.close();
});

/** A store owner (first/last name as typed at sign-up) with one store, and a session for its API. */
async function owner(firstName: string, lastName: string, storeName: string, vendorType: 'RESTAURANT' | 'SUPERMARKET' | 'STORE' | 'SERVICE' = 'STORE') {
  seq += 1;
  const user = await system(() => app.prisma.user.create({ data: {
    phone: `+5928${NUM}${String(seq).padStart(2, '0')}`, firstName, lastName, roles: ['VENDOR_OWNER', 'CUSTOMER'], activeRole: 'VENDOR_OWNER',
    countryCode: 'GY', status: 'ACTIVE', isPhoneVerified: true,
  } }));
  users.push(user.id);
  await signupSelfieFixture(app.prisma, user.id);
  const vendorOwner = await runWithTenant('swift-default', () => app.prisma.vendorOwner.create({ data: { userId: user.id, vendors: { create: {
    name: storeName, slug: `own-${RUN.toLowerCase()}-${seq}`, vendorType, phone: `+5928${NUM}9${seq}`, addressLine1: '1 Own Lane', city: 'Georgetown', region: 'Demerara-Mahaica',
    latitude: 6.8, longitude: -58.16, status: 'PENDING_APPROVAL', publicPhone: '+5926001234',
  } } }, include: { vendors: true } }));
  const token = app.jwt.sign({ userId: user.id, role: 'VENDOR_OWNER', jti: nanoid(8) });
  await runWithTenant('swift-default', () => app.prisma.session.create({ data: { userId: user.id, token, refreshToken: nanoid(24), deviceId: `own-${seq}`, deviceType: 'test', expiresAt: new Date(Date.now() + DAY) } }));
  return { userId: user.id, vendorId: vendorOwner.vendors[0]!.id, token, vendorType };
}
const call = (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, o: { token: string; vendorId: string }, payload?: Record<string, unknown>) => app.inject({
  method, url, ...(payload ? { payload } : {}),
  headers: { authorization: `Bearer ${o.token}`, 'x-vendor-id': o.vendorId, ...(payload ? { 'content-type': 'application/json' } : {}) },
});
const sign = (o: { token: string; vendorId: string }) => call('POST', '/api/v1/vendor/onboarding/own-name', o, { accept: true, attestationVersion: 'v1' });
const statusOf = async (o: { token: string; vendorId: string }, role = 'STORE') => (await call('GET', `/api/v1/verification/status?role=${role}`, o)).json().data;

describe('[ROLE-DOCS] what counts as trading under your own name (BNA s.3)', () => {
  it('the surname, with only first names or their initials, in any order; nothing added; never another name', () => {
    for (const ok of ['Persaud', 'R. Persaud', 'R Persaud', 'Ramesh Persaud', 'Persaud Ramesh', 'RAMESH K. PERSAUD', 'Ramesh Kumar Persaud']) {
      expect(storeNameIsOwnName(ok, 'Ramesh Kumar', 'Persaud'), ok).toBe(true);
    }
    for (const no of ['Persaud’s Shop', 'Persaud Enterprises', 'Persaud & Sons', 'Persauds', 'Singh', 'Ramesh', 'R.K. Supermarket', '', 'Shop']) {
      expect(storeNameIsOwnName(no, 'Ramesh Kumar', 'Persaud'), no).toBe(false);
    }
    // a double-barrelled surname counts as one, whole
    expect(storeNameIsOwnName('A. Fung-A-Fat', 'Anne', 'Fung-A-Fat')).toBe(true);
    expect(storeNameIsOwnName('Fung', 'Anne', 'Fung-A-Fat')).toBe(false);
  });

  it('the phone app and the website show exactly the words the server records', () => {
    expect(MOBILE_WORDS).toBe(OWN_NAME_DECLARATION_V1);
    expect(WEB_WORDS).toBe(OWN_NAME_DECLARATION_V1);
    expect(OWN_NAME_DECLARATION_V1).toMatch(/Business Names \(Registration\) Act, Cap\. 90:05, section 3/);
  });

  it('the own-name lists replace ONLY the business registration, for the three store types asked for one', () => {
    for (const role of ['RESTAURANT', 'SUPERMARKET', 'STORE']) {
      const standard = DEFAULT_DOCUMENT_CHECKLISTS[role]!;
      expect(DEFAULT_DOCUMENT_CHECKLISTS[`${role}_OWN_NAME`], role).toEqual(standard.map((t) => (t === 'business_registration' ? 'own_name_declaration' : t)));
    }
    expect(DEFAULT_DOCUMENT_CHECKLISTS['SERVICE_OWN_NAME']).toBeUndefined();
    expect(reviewerTypedFields('own_name_declaration')).toEqual(['ownNameConfirmed']);
  });
});

describe('[ROLE-DOCS] sign-up asks first; the server refuses what clearly is not an own name', () => {
  it('POST /partner/become with nameBasis OWN_NAME refuses a trading name before the store exists', async () => {
    const o = await owner('Ramesh', 'Persaud', `Holder ${RUN}`);
    const res = await call('POST', '/api/v1/partner/become', o, { role: 'VENDOR', acceptAgreement: true, business: {
      name: 'Persaud Enterprises', vendorType: 'STORE', phone: '+5926000000', addressLine1: '1 Own Lane', city: 'Georgetown', latitude: 6.8, longitude: -58.16, nameBasis: 'OWN_NAME',
    } });
    expect(res.statusCode, res.body).toBe(400);
    expect(res.json().error.code).toBe('OWN_NAME_MISMATCH');
    const service = await call('POST', '/api/v1/partner/become', o, { role: 'VENDOR', acceptAgreement: true, business: {
      name: 'Persaud', vendorType: 'SERVICE', phone: '+5926000000', addressLine1: '1 Own Lane', city: 'Georgetown', latitude: 6.8, longitude: -58.16, nameBasis: 'OWN_NAME',
    } });
    expect(service.statusCode).toBe(400);
    expect(service.json().error.code).toBe('OWN_NAME_NOT_APPLICABLE');
  });
});

describe('[ROLE-DOCS] the declaration replaces the business registration, checked by a person', () => {
  it('signs, is reviewed against the ID, and the store goes live on it without a business registration', async () => {
    const o = await owner('Ramesh', 'Persaud', 'R. Persaud');
    expect((await statusOf(o)).checklist).toEqual(['owner_national_id', 'business_registration', 'storefront_photo']);
    expect((await statusOf(o)).nameBasis).toBe('REGISTERED');
    const signed = await sign(o);
    expect(signed.statusCode, signed.body).toBe(201);
    expect(signed.json().data.declaration.status).toBe('PENDING');
    const status = await statusOf(o);
    expect(status.nameBasis).toBe('OWN_NAME');
    expect(status.checklist).toEqual(['owner_national_id', 'own_name_declaration', 'storefront_photo']);
    expect(status.checklist).not.toContain('business_registration');
    expect(await system(() => app.prisma.consentRecord.count({ where: { subjectId: o.userId, documentType: OWN_NAME_CONSENT_TYPE } }))).toBe(1);
    expect((await system(() => app.prisma.vendor.findUniqueOrThrow({ where: { id: o.vendorId } }))).tradesUnderOwnName).toBe(true);
    // a second signature waits for the first
    expect((await sign(o)).json().error.code).toBe('OWN_NAME_DECLARATION_EXISTS');

    // a person must say they checked the name against the ID — never approved by default
    const declaration = signed.json().data.declaration.id as string;
    await expect(service.approveDocument(declaration, adminId)).rejects.toMatchObject({ code: 'OWN_NAME_CONFIRMATION_REQUIRED' });
    await expect(service.approveDocument(declaration, adminId, undefined, undefined, { ownNameConfirmed: false })).rejects.toMatchObject({ code: 'OWN_NAME_CONFIRMATION_REQUIRED' });
    await service.approveDocument(declaration, adminId, undefined, undefined, { ownNameConfirmed: true });

    for (const docType of ['owner_national_id', 'storefront_photo']) {
      const doc = await service.submitDocument(o.userId, 'STORE', docType, await ownedVerificationFixture(app.prisma, o.userId, `own-${docType}`), 'v1');
      await service.approveDocument(doc.id, adminId, undefined, undefined, docType === 'owner_national_id' ? { documentNumber: `ID${NUM}` } : {});
    }
    const live = await statusOf(o);
    expect(live.missing).toEqual([]);
    expect(live.roleVerified).toBe(true);
    const store = await system(() => app.prisma.vendor.findUniqueOrThrow({ where: { id: o.vendorId } }));
    expect([store.isVerified, store.status]).toEqual([true, 'ACTIVE']);

    // the name a person checked is not changed in the app
    const rename = await call('PUT', '/api/v1/vendor/profile', o, { name: 'Persaud Supermarket' });
    expect(rename.statusCode).toBe(409);
    expect(rename.json().error.code).toBe('OWN_NAME_RENAME');

    // switching back to a business name asks for the registration again, and the store is no longer verified
    const dropped = await call('DELETE', '/api/v1/vendor/onboarding/own-name', o);
    expect(dropped.statusCode).toBe(200);
    expect(dropped.json().data.status.checklist).toContain('business_registration');
    expect((await system(() => app.prisma.vendor.findUniqueOrThrow({ where: { id: o.vendorId } }))).isVerified).toBe(false);
    // and the old approval is never reused for a later name: support decides
    expect((await sign(o)).json().error.code).toBe('OWN_NAME_SUPPORT');
  });

  it('refuses to sign for a name that is not the owner\'s own, for a service business, and once a registration is on file', async () => {
    const trading = await owner('Ramesh', 'Persaud', 'Persaud Enterprises');
    const res = await sign(trading);
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('OWN_NAME_MISMATCH');
    expect(await system(() => app.prisma.verificationDocument.count({ where: { userId: trading.userId, docType: 'own_name_declaration' } }))).toBe(0);
    expect((await system(() => app.prisma.vendor.findUniqueOrThrow({ where: { id: trading.vendorId } }))).tradesUnderOwnName).toBe(false);

    const services = await owner('Anne', 'Fung', 'Fung', 'SERVICE');
    expect((await sign(services)).json().error.code).toBe('OWN_NAME_NOT_APPLICABLE');

    const registered = await owner('Mark', 'Singh', 'Singh');
    await system(() => app.prisma.verificationDocument.create({ data: {
      userId: registered.userId, role: 'VENDOR_OWNER', docType: 'business_registration', fileUrl: `storage://t/${RUN}-reg.jpg`, status: 'APPROVED', reviewedAt: new Date(), reviewedBy: 'admin-fixture',
      consentAt: new Date(), privacyNoticeVersion: 'v1',
    } }));
    expect((await sign(registered)).json().error.code).toBe('ALREADY_REGISTERED');
  });
});

describe('[ROLE-DOCS · security review] only the signed route creates an own-name declaration, and only a person approves it', () => {
  it('the generic upload route and the generic service path refuse the type, before anything is recorded', async () => {
    const o = await owner('Ramesh', 'Persaud', 'Persaud');
    await system(() => app.prisma.vendor.update({ where: { id: o.vendorId }, data: { tradesUnderOwnName: true } }));
    // the checklist names it, so without the guard the generic route would take an uploaded file as the declaration
    expect((await statusOf(o)).checklist).toContain('own_name_declaration');
    const res = await call('POST', '/api/v1/verification/documents', o, {
      role: 'STORE', docType: 'own_name_declaration', fileUrl: await ownedVerificationFixture(app.prisma, o.userId, 'forged-declaration'), consent: true, privacyNoticeVersion: 'v1',
    });
    expect(res.statusCode, res.body).toBe(400);
    expect(res.json().error.code).toBe('OWN_NAME_SIGNED_ONLY');
    await expect(service.submitDocument(o.userId, 'STORE', 'own_name_declaration', await ownedVerificationFixture(app.prisma, o.userId, 'forged-2'), 'v1'))
      .rejects.toMatchObject({ code: 'OWN_NAME_SIGNED_ONLY' });
    expect(await system(() => app.prisma.verificationDocument.count({ where: { userId: o.userId, docType: 'own_name_declaration' } }))).toBe(0);
  });

  it('an engine that would approve it automatically never does: the declaration always waits for a person', async () => {
    const o = await owner('Mark', 'Singh', 'M. Singh');
    await system(() => app.prisma.vendor.update({ where: { id: o.vendorId }, data: { tradesUnderOwnName: true } }));
    const auto = new VerificationService(app.prisma, new NotificationService(app.prisma, app.io), new SandboxKycProvider());
    const doc = await auto.submitDocument(o.userId, 'STORE', 'own_name_declaration', await ownedVerificationFixture(app.prisma, o.userId, 'auto-approve-own'), 'v1', undefined, { ownNameSigned: true });
    expect(doc).toMatchObject({ status: 'PENDING', reviewedBy: null });
    expect(ALWAYS_REVIEW_LEGACY_CODES.has(OWN_NAME_DOC_TYPE)).toBe(true);
    const row = await system(() => app.prisma.docType.findUniqueOrThrow({ where: { code: 'GY.own_name_declaration' } }));
    expect(row.alwaysReview).toBe(true);
  });
});
