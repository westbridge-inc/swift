/**
 * [DOC-1 Part I · §9.1 · P1-1] test_retention_policy_per_doc_type
 *
 * Retention is a (country, document type, role) policy row, not one country-wide number:
 * the registry's persistRetentionDays sets the clock for a persisted image, the AML switch
 * extends it to seven years, and a type with no registry row falls back to the country
 * default. When a participant leaves, every document gets ITS clock.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { socketPlugin } from '../plugins/socket';
import { registerErrorHandler } from '../middleware/error-handler';
import { runWithTenant, runWithoutTenant } from '../plugins/tenant-context';
import { VerificationService } from '../modules/verification/verification.service';
import { NotificationService } from '../modules/notification/notification.service';
import { CountryConfigService } from '../modules/country/country-config.service';
import { SandboxKycProvider } from '../providers/kyc/kyc-provider';
import { seedDocRegistry, registryCode } from '../modules/verification/doc-registry';
import { retentionDaysFor, AML_RETENTION_DAYS } from '../modules/verification/retention-policy';

const RUN = nanoid(8).replace(/[^a-zA-Z0-9]/g, '0');
const NUM = String(Date.now()).slice(-5);
const DAY = 86_400_000;

let app: FastifyInstance;
let service: VerificationService;
let countryDefault = 0;
const users: string[] = [];
const touched: string[] = [];
const system = <T>(fn: () => Promise<T>) => runWithoutTenant(fn, 'doc1-retention-policy-test');

beforeAll(async () => {
  process.env['NODE_ENV'] = 'test';
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(prismaPlugin); await app.register(redisPlugin); await app.register(socketPlugin);
  await app.ready();
  service = new VerificationService(app.prisma, new NotificationService(app.prisma, app.io), new SandboxKycProvider());
  await system(() => seedDocRegistry(app.prisma));
  countryDefault = (await new CountryConfigService(app.prisma).getByCode('GY')).dataRetentionDays;
});

afterAll(async () => {
  await system(async () => {
    for (const code of touched) await app.prisma.docType.update({ where: { code }, data: { amlRecordClass: 'NOT_APPLICABLE', persistRetentionDays: 2555 } });
    await app.prisma.verificationDocument.deleteMany({ where: { userId: { in: users } } });
    await app.prisma.subject.deleteMany({ where: { createdById: { in: users } } });
    await app.prisma.user.deleteMany({ where: { id: { in: users } } });
  });
  await app.close();
});

describe('[DOC-1 P1-1] retention is a policy row per (country, type, role)', () => {
  it('the registry row sets the clock; the AML switch extends it to seven years; an unknown type falls back to the country default', async () => {
    const business = await system(() => app.prisma.docType.findUniqueOrThrow({ where: { code: registryCode('GY', 'business_registration') }, select: { persistRetentionDays: true } }));
    expect(business.persistRetentionDays).not.toBeNull();
    const fromRegistry = await system(() => retentionDaysFor(app.prisma, { countryCode: 'GY', docType: 'business_registration', role: 'VENDOR_OWNER', countryDefaultDays: countryDefault }));
    expect(fromRegistry).toMatchObject({ days: business.persistRetentionDays, source: 'REGISTRY' });
    const unknown = await system(() => retentionDaysFor(app.prisma, { countryCode: 'GY', docType: `no_such_type_${RUN}`, role: 'VENDOR_OWNER', countryDefaultDays: countryDefault }));
    expect(unknown).toMatchObject({ days: countryDefault, source: 'COUNTRY_DEFAULT' });
    const code = registryCode('GY', 'tin_certificate');
    // a one-year registry clock, then the AML switch: seven years wins (max of the two)
    await system(() => app.prisma.docType.update({ where: { code }, data: { persistRetentionDays: 365, amlRecordClass: 'CDD_ENTITY' } })); touched.push(code);
    const registryOnly = await system(() => retentionDaysFor(app.prisma, { countryCode: 'GY', docType: 'business_registration', role: 'VENDOR_OWNER', countryDefaultDays: countryDefault }));
    expect(registryOnly.source).toBe('REGISTRY');
    const aml = await system(() => retentionDaysFor(app.prisma, { countryCode: 'GY', docType: 'tin_certificate', role: 'VENDOR_OWNER', countryDefaultDays: countryDefault }));
    expect(aml).toMatchObject({ days: AML_RETENTION_DAYS, source: 'AML' });
    expect(AML_RETENTION_DAYS).toBe(2555);
  });

  it('when a participant leaves, every document gets ITS clock — two types, two different retention dates, the AML one seven years out', async () => {
    const u = await runWithTenant('swift-default', () => app.prisma.user.create({ data: {
      phone: `+59263${NUM}1`, firstName: 'Ret', lastName: `Ention${RUN}`, activeRole: 'VENDOR_OWNER', roles: ['VENDOR_OWNER'], countryCode: 'GY',
    } }));
    users.push(u.id);
    const purgeType = await system(() => app.prisma.docType.findUniqueOrThrow({ where: { code: registryCode('GY', 'owner_national_id') }, select: { persistRetentionDays: true, imagePolicy: true } }));
    expect(purgeType.imagePolicy).toBe('PURGE_AFTER_REVIEW'); expect(purgeType.persistRetentionDays).toBeNull(); // → country default
    const mk = (docType: string) => system(() => app.prisma.verificationDocument.create({ data: { userId: u.id, role: 'VENDOR_OWNER', docType, fileUrl: `x/${RUN}/${docType}`, status: 'APPROVED' } }));
    const personal = await mk('owner_national_id'); const reg = await mk('business_registration'); const tin = await mk('tin_certificate');
    const before = Date.now();
    expect(await service.scheduleDocumentRetention(u.id)).toBe(3);
    const at = async (id: string) => (await system(() => app.prisma.verificationDocument.findUniqueOrThrow({ where: { id }, select: { retentionExpiresAt: true } }))).retentionExpiresAt!.getTime();
    const business = await system(() => app.prisma.docType.findUniqueOrThrow({ where: { code: registryCode('GY', 'business_registration') }, select: { persistRetentionDays: true } }));
    const near = (actual: number, days: number) => Math.abs(actual - (before + days * DAY)) < 60_000;
    expect(near(await at(personal.id), countryDefault)).toBe(true);
    expect(near(await at(reg.id), business.persistRetentionDays!)).toBe(true);
    expect(near(await at(tin.id), AML_RETENTION_DAYS)).toBe(true); // still flagged CDD_ENTITY from the first test
    expect(await at(tin.id)).toBeGreaterThan(await at(reg.id));
  });
});
