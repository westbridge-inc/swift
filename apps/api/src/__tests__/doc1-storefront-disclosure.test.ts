/**
 * [DOC-1 Part XIX · DOC-INV-27 · P19] test_no_storefront_without_disclosure
 *
 * The supplier-information block is compiled from VALID document records and labelled
 * fallbacks, never hand-written: an unregistered proprietor's name "trading as" the store
 * (from the verified identity record), the self-declared address labelled as such, the
 * verified account contact, every VALID licence record, and the platform operator block
 * from configuration. It is derived on every read: an expired licence leaves the block in
 * the same sweep. Once the country's business document types are ACTIVE, a store with an
 * incomplete block cannot go live; before activation the block is shown but does not gate.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { registerErrorHandler } from '../middleware/error-handler';
import { customerRoutes } from '../modules/user/customer.routes';
import { runWithTenant, runWithoutTenant } from '../plugins/tenant-context';
import { VerificationService } from '../modules/verification/verification.service';
import { NotificationService } from '../modules/notification/notification.service';
import { SandboxKycProvider } from '../providers/kyc/kyc-provider';
import { seedDocRegistry, registryCode } from '../modules/verification/doc-registry';
import { compileStorefrontDisclosure, disclosureGateEngaged, platformOperator } from '../modules/verification/storefront-disclosure';
import { documentRecordDdl } from '../modules/verification/document-record';
import { docStateMachineDdl } from '../modules/verification/doc-state';
import { installDdl } from './helpers/install-ddl';
import { grantSuiteCapability } from '../lib/test-target-lock';
import { rlsDdlFor, tenantLineageDdl } from '../lib/tenant-rls';

grantSuiteCapability('ddl');

const RUN = nanoid(8).replace(/[^a-zA-Z0-9]/g, '0');
const NUM = String(Date.now()).slice(-5);
const DAY = 86_400_000;
const OPERATOR = { PLATFORM_LEGAL_NAME: 'Westbridge Inc.', PLATFORM_REGISTERED_ADDRESS: '1 Main Street, Georgetown, Guyana', SUPPORT_EMAIL: 'support@example.gy' };
const prevEnv: Record<string, string | undefined> = {};

let app: FastifyInstance;
let service: VerificationService;
const users: string[] = [];
const activated: string[] = [];
const system = <T>(fn: () => Promise<T>) => runWithoutTenant(fn, 'doc1-storefront-disclosure-test');

async function store(n: number) {
  const u = await runWithTenant('swift-default', () => app.prisma.user.create({ data: {
    phone: `+59266${NUM}${n}`, firstName: 'Priya', lastName: `Persaud${n}`, activeRole: 'VENDOR_OWNER', roles: ['VENDOR_OWNER'], countryCode: 'GY', isPhoneVerified: true,
    avatar: `avatars/${RUN}/${n}.jpg`, selfieCapturedAt: new Date(),
  } }));
  users.push(u.id);
  const owner = await runWithTenant('swift-default', () => app.prisma.vendorOwner.create({ data: { userId: u.id, vendors: { create: {
    name: `Priya's Snackette ${RUN}${n}`, slug: `priyas-snackette-${RUN.toLowerCase()}-${n}`, vendorType: 'RESTAURANT', phone: `+59266${NUM}${n}`,
    addressLine1: `${n} Sheriff Street`, addressLine2: 'Georgetown', city: 'Georgetown', region: 'Demerara-Mahaica', latitude: 6.8, longitude: -58.16, status: 'PENDING_APPROVAL',
  } } }, include: { vendors: true } }));
  return { userId: u.id, vendorId: owner.vendors[0]!.id };
}
const approved = (userId: string, docType: string, extra: Record<string, unknown> = {}) => system(() => app.prisma.verificationDocument.create({ data: {
  userId, role: 'VENDOR_OWNER', docType, fileUrl: `/uploads/verification/${RUN}/${docType}-${nanoid(4)}.enc`, status: 'APPROVED', reviewedBy: 'disclosure-test', reviewedAt: new Date(), expiresAt: new Date(Date.now() + 200 * DAY), ...extra,
} }));
const vendorOf = (id: string) => system(() => app.prisma.vendor.findUniqueOrThrow({ where: { id }, select: { isVerified: true, status: true } }));
const checklistFor = async (userId: string) => (service as unknown as { checklistFor: (u: string, c: string, r: string) => Promise<string[]> }).checklistFor(userId, 'GY', 'RESTAURANT');

beforeAll(async () => {
  process.env['NODE_ENV'] = 'test';
  for (const [k, v] of Object.entries(OPERATOR)) { prevEnv[k] = process.env[k]; process.env[k] = v; }
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(prismaPlugin); await app.register(redisPlugin); await app.register(authPlugin); await app.register(socketPlugin);
  await app.register(customerRoutes, { prefix: '/api/v1/customer' });
  await app.ready();
  const tables = ['subject', 'subject_link', 'person_profile', 'business_profile', 'vehicle_profile', 'document_record'];
  await installDdl(app.prisma, [...tables.flatMap((t) => rlsDdlFor(t)), ...tenantLineageDdl().filter((s) => tables.some((t) => s.includes(`${t}_tenant_matches`))), ...docStateMachineDdl(), ...documentRecordDdl()]);
  service = new VerificationService(app.prisma, new NotificationService(app.prisma, app.io), new SandboxKycProvider());
  await system(() => seedDocRegistry(app.prisma));
});

afterAll(async () => {
  for (const k of Object.keys(OPERATOR)) { if (prevEnv[k] === undefined) delete process.env[k]; else process.env[k] = prevEnv[k]; }
  await system(async () => {
    if (activated.length) await app.prisma.docType.updateMany({ where: { code: { in: activated } }, data: { isActive: false, legalFactsVerifiedAt: null } });
    await app.prisma.verificationDocument.deleteMany({ where: { userId: { in: users } } });
    await app.prisma.subject.deleteMany({ where: { createdById: { in: users } } });
    const owners = await app.prisma.vendorOwner.findMany({ where: { userId: { in: users } }, select: { id: true } });
    await app.prisma.vendor.deleteMany({ where: { ownerId: { in: owners.map((o) => o.id) } } });
    await app.prisma.vendorOwner.deleteMany({ where: { userId: { in: users } } });
    await app.prisma.notification.deleteMany({ where: { userId: { in: users } } });
    await app.prisma.user.deleteMany({ where: { id: { in: users } } });
  });
  await app.close();
});

describe('[DOC-1 P19] the disclosure is compiled, never written', () => {
  it('names what is missing; the verified proprietor "trading as" the store fills the legal name; the address is labelled self-declared; the contact is the verified account; licences appear while VALID and leave when they expire', async () => {
    const { userId, vendorId } = await store(1);
    const bare = await system(() => compileStorefrontDisclosure(app.prisma, vendorId));
    expect(bare.complete).toBe(false);
    expect(bare.missing).toEqual(['legalName']);
    expect(bare.address).toMatchObject({ source: 'SELF_DECLARED', value: '1 Sheriff Street, Georgetown' });
    expect(bare.contact).toMatchObject({ source: 'ACCOUNT' });
    expect(bare.operator).toEqual({ legalName: 'Westbridge Inc.', registeredAddress: '1 Main Street, Georgetown, Guyana', supportEmail: 'support@example.gy' });

    await approved(userId, 'owner_national_id');
    const named = await system(() => compileStorefrontDisclosure(app.prisma, vendorId));
    expect(named.complete).toBe(true);
    expect(named.legalName).toMatchObject({ source: 'PROPRIETOR', docType: 'owner_national_id' });
    expect(named.legalName!.value).toBe(`Priya Persaud1 trading as Priya's Snackette ${RUN}1`);

    const licence = await approved(userId, 'food_handler_cert');
    expect((await system(() => compileStorefrontDisclosure(app.prisma, vendorId))).licences).toEqual([{ value: 'on file', source: 'RECORD', docType: 'food_handler_cert', recordId: expect.any(String) }]);
    await system(() => app.prisma.verificationDocument.update({ where: { id: licence.id }, data: { expiresAt: new Date(Date.now() - DAY) } }));
    await system(() => service.expireLapsedDocuments());
    expect((await system(() => compileStorefrontDisclosure(app.prisma, vendorId))).licences).toEqual([]);
  });

  it('the storefront read carries the block; without the operator configuration the block says so', async () => {
    const { vendorId } = await store(2);
    const res = await app.inject({ method: 'GET', url: `/api/v1/customer/vendors/${vendorId}` });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.disclosure).toMatchObject({ complete: false, missing: ['legalName'] });
    expect(platformOperator({})).toBeNull();
    expect(platformOperator({ PLATFORM_LEGAL_NAME: 'X', PLATFORM_REGISTERED_ADDRESS: 'Y' })).toBeNull();
  });

  it('DOC-INV-27: once the business types are active, a store with an incomplete block cannot go live; complete it and it activates', async () => {
    const { userId, vendorId } = await store(3);
    const checklist = await checklistFor(userId);
    for (const t of checklist.filter((x) => x !== 'owner_national_id')) await approved(userId, t);
    const beforeGate = await system(() => disclosureGateEngaged(app.prisma, 'GY'));
    expect(beforeGate).toBe(false);
    // activate a BUSINESS-bucket type: the gate engages
    const code = registryCode('GY', 'business_registration');
    await system(() => app.prisma.docType.update({ where: { code }, data: { isActive: true, legalFactsVerifiedAt: new Date() } }));
    activated.push(code);
    expect(await system(() => disclosureGateEngaged(app.prisma, 'GY'))).toBe(true);
    // the checklist still lacks the identity document → not verified, and the block is incomplete
    expect(await system(() => service.isRoleVerified(userId, 'RESTAURANT'))).toBe(false);
    // give it every checklist type EXCEPT via a path that leaves the block incomplete: remove the operator config
    await approved(userId, 'owner_national_id');
    expect(await system(() => service.isRoleVerified(userId, 'RESTAURANT'))).toBe(true);
    const savedOp = process.env['SUPPORT_EMAIL']; delete process.env['SUPPORT_EMAIL'];
    const projection = service as unknown as { projectVendorActivation: (db: unknown, u: string) => Promise<void> };
    await system(() => projection.projectVendorActivation(app.prisma, userId));
    expect(await vendorOf(vendorId)).toMatchObject({ isVerified: false, status: 'PENDING_APPROVAL' });
    process.env['SUPPORT_EMAIL'] = savedOp;
    await system(() => projection.projectVendorActivation(app.prisma, userId));
    expect(await vendorOf(vendorId)).toMatchObject({ isVerified: true, status: 'ACTIVE' });
  });
});
