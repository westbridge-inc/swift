/**
 * [VERIFY-DOCS · owner ruling 5, 6 Oct 2026] Less data.
 *
 *  - Swift stops declaring a person's sex and nationality on identity documents, and the
 *    vehicle owner's name on a registration (it can be a third party's). Nothing needs them:
 *    an ID proves name, date of birth, number and expiry; a registration ties the vehicle.
 *    An older install's declarations are retired by the next registry seed, and no empty
 *    placeholder for them is shown afterwards (the subject's own export, the custody trail).
 *  - A medical certificate is never accepted, whatever a list says (health data is sensitive).
 *
 * The food handler's permit ("on file" on the storefront) is pinned in doc1-storefront-disclosure.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { registerErrorHandler } from '../middleware/error-handler';
import { runWithoutTenant } from '../plugins/tenant-context';
import { verificationRoutes } from '../modules/verification/verification.routes';
import { DEFAULT_DOCUMENT_CHECKLISTS } from '../modules/ops/platform-config';
import { CATEGORY_GATES, EXTRA_DOC_TYPES, FIELD_CATALOGUE, BUCKET_OF, REGISTRY_EFFECTIVE_FROM, REGISTRY_TIER, registryCode, seedDocRegistry } from '../modules/verification/doc-registry';
import { custodyNarrative } from '../modules/verification/custody';
import { exportDocumentsFor } from '../modules/verification/dsar';
import { CountryConfigService } from '../modules/country/country-config.service';
import { providerChecklist } from '../modules/services/services.service';
import { ownedVerificationFixture } from './helpers/verification-object';

const DAY = 86_400_000;
const phoneBase = 592_008_000_000 + Math.floor(Math.random() * 900_000);
const users: string[] = [];
let app: FastifyInstance;
const system = <T>(fn: () => Promise<T>) => runWithoutTenant(fn, 'verify-docs-less-data-test');

const IDENTITY_TYPES = ['national_id', 'owner_national_id', 'passport', 'digital_id'];
const RETIRED: Array<[string, string]> = [
  ...IDENTITY_TYPES.flatMap((t) => [[t, 'sex'], [t, 'nationality']] as Array<[string, string]>),
  ['vehicle_registration', 'owner_name'],
];

beforeAll(async () => {
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  await app.register(verificationRoutes, { prefix: '/api/v1/verification' });
  await app.ready();
});

afterAll(async () => {
  if (!app) return;
  if (users.length) {
    await system(async () => {
      await app.prisma.rectificationRequest.deleteMany({ where: { userId: { in: users } } });
      await app.prisma.verificationDocument.deleteMany({ where: { userId: { in: users } } });
      await app.prisma.notification.deleteMany({ where: { userId: { in: users } } });
      await app.prisma.user.deleteMany({ where: { id: { in: users } } });
    });
  }
  await app.close();
});

async function rider() {
  const user = await app.prisma.user.create({ data: {
    phone: `+${phoneBase + users.length}`, firstName: 'Synthetic', lastName: `Rider${users.length}`, activeRole: 'RIDER', roles: ['RIDER', 'CUSTOMER'],
    countryCode: 'GY', isPhoneVerified: true, selfieCapturedAt: new Date(),
  } });
  users.push(user.id);
  await app.prisma.rider.create({ data: { userId: user.id, riderType: 'DELIVERY', vehicleType: 'BICYCLE' } });
  const token = app.jwt.sign({ userId: user.id, role: 'RIDER', jti: nanoid() });
  await app.prisma.session.create({ data: { userId: user.id, token, refreshToken: nanoid(48), deviceId: nanoid(), deviceType: 'test', expiresAt: new Date(Date.now() + DAY) } });
  return { userId: user.id, token };
}

/** A submission an older build extracted: the registry then declared sex and nationality, so the run left EMPTY placeholders for them. */
async function olderExtraction(userId: string, docType = 'national_id', fields = ['doc_number', 'sex', 'nationality', 'full_name']) {
  return system(async () => {
    const doc = await app.prisma.verificationDocument.create({ data: {
      userId, role: 'MOVER', docType, fileUrl: `/uploads/verification/${userId}/older-${nanoid(6)}.enc`, status: 'PENDING',
      consentAt: new Date(), privacyNoticeVersion: 'v1',
    } });
    await app.prisma.extractionRun.create({ data: {
      submissionId: doc.id, profileCode: 'UNPROFILED', engineName: 'older-build', engineVersion: '1', startedAt: new Date(), finishedAt: new Date(), outcome: 'PARTIAL',
      fields: { create: fields.map((fieldCode) => ({ submissionId: doc.id, fieldCode, valueCt: null, source: 'PROVIDER' as const })) },
    } });
    return doc.id;
  });
}

describe('[VERIFY-DOCS] the registry no longer declares sex, nationality or a third-party vehicle owner’s name', () => {
  it('the field catalogue declares none of them, and keeps what verification needs', () => {
    for (const t of IDENTITY_TYPES) {
      const codes = (FIELD_CATALOGUE[t] ?? []).map((f) => f.fieldCode);
      expect(codes, t).not.toContain('sex');
      expect(codes, t).not.toContain('nationality');
      for (const kept of ['doc_number', 'full_name', 'dob', 'expiry_date']) expect(codes, `${t}/${kept}`).toContain(kept);
    }
    const registration = (FIELD_CATALOGUE['vehicle_registration'] ?? []).map((f) => f.fieldCode);
    expect(registration).not.toContain('owner_name');
    expect(registration).toContain('registration_mark');
  });

  it('a registry seed retires the declarations an older seed made', async () => {
    await system(() => seedDocRegistry(app.prisma));
    // What an install seeded by an older build still holds.
    for (const [type, fieldCode] of RETIRED) {
      const docTypeCode = registryCode('GY', type);
      if (!(await app.prisma.docType.findUnique({ where: { code: docTypeCode } }))) continue;
      await system(() => app.prisma.docField.upsert({
        where: { docTypeCode_fieldCode: { docTypeCode, fieldCode } },
        create: { docTypeCode, fieldCode, dataType: 'text', isRequired: false, isPii: true, displayOrder: 99 },
        update: {},
      }));
    }
    await system(() => seedDocRegistry(app.prisma));
    for (const [type, fieldCode] of RETIRED) {
      expect(await app.prisma.docField.count({ where: { docTypeCode: registryCode('GY', type), fieldCode } }), `${type}.${fieldCode}`).toBe(0);
    }
    // ... and only those: the fields verification reads are still declared.
    expect(await app.prisma.docField.count({ where: { docTypeCode: registryCode('GY', 'national_id'), fieldCode: 'doc_number' } })).toBe(1);
    expect(await app.prisma.docField.count({ where: { docTypeCode: registryCode('GY', 'vehicle_registration'), fieldCode: 'registration_mark' } })).toBe(1);
  });

  it('an empty placeholder left by an older extraction is shown nowhere: not in the person’s export, not in the custody trail', async () => {
    const m = await rider();
    const id = await olderExtraction(m.userId);
    const exported = await system(() => exportDocumentsFor(app.prisma, m.userId));
    const fields = exported.documents.find((d) => d.id === id)!.fields.map((f) => f.fieldCode);
    expect(fields).toContain('doc_number');
    expect(fields).not.toContain('sex');
    expect(fields).not.toContain('nationality');
    const custody = await system(() => custodyNarrative(app.prisma, id));
    const extracted = JSON.stringify(custody.timeline.filter((e) => e.what.startsWith('EXTRACTED')));
    expect(extracted).toContain('doc_number:absent');
    expect(extracted).not.toContain('sex:');
    expect(extracted).not.toContain('nationality:');
  });

  it('a retired field cannot collect a new correction note through its historical placeholder', async () => {
    const m = await rider();
    const documentId = await olderExtraction(m.userId);
    for (const fieldCode of ['sex', 'nationality']) {
      const res = await app.inject({ method: 'POST', url: '/api/v1/verification/dsar/documents/rectify',
        headers: { authorization: `Bearer ${m.token}` },
        payload: { documentId, fieldCode, note: 'Synthetic correction value that must not be collected' } });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('UNKNOWN_FIELD');
    }
    expect(await app.prisma.rectificationRequest.count({ where: { submissionId: documentId } })).toBe(0);
    const registration = await olderExtraction(m.userId, 'vehicle_registration', ['owner_name', 'registration_mark']);
    const res = await app.inject({ method: 'POST', url: '/api/v1/verification/dsar/documents/rectify',
      headers: { authorization: `Bearer ${m.token}` },
      payload: { documentId: registration, fieldCode: 'owner_name', note: 'Synthetic third-party correction that must not be collected' } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('UNKNOWN_FIELD');
    expect(await app.prisma.rectificationRequest.count({ where: { submissionId: registration } })).toBe(0);
  });
});

describe('[VERIFY-DOCS] a medical certificate is never accepted', () => {
  it.each(['health_report', 'clinic_report', 'hospital_letter'])('the medical alias %s is refused before it is minted or submitted', async (docType) => {
    const gy = await app.prisma.countryConfig.findUniqueOrThrow({ where: { code: 'GY' } });
    const stored = gy.documentChecklists as Record<string, string[]>;
    await app.prisma.countryConfig.update({ where: { code: 'GY' }, data: { documentChecklists: { ...stored, MOVER_OPTIONAL: [docType] } } });
    try {
      const m = await rider();
      const res = await app.inject({ method: 'POST', url: '/api/v1/verification/documents', headers: { authorization: `Bearer ${m.token}` },
        payload: { role: 'MOVER', docType, fileUrl: await ownedVerificationFixture(app.prisma, m.userId, 'medical-alias'), consent: true, privacyNoticeVersion: 'v1' } });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('DOC_TYPE_NOT_ACCEPTED');
      expect(await app.prisma.verificationDocument.count({ where: { userId: m.userId, docType } })).toBe(0);
      await system(() => seedDocRegistry(app.prisma));
      expect(await app.prisma.docType.count({ where: { code: registryCode('GY', docType) } })).toBe(0);
    } finally {
      await app.prisma.countryConfig.update({ where: { code: 'GY' }, data: { documentChecklists: stored } });
      await system(async () => {
        await app.prisma.requirementItem.deleteMany({ where: { docTypeCode: registryCode('GY', docType) } });
        await app.prisma.docField.deleteMany({ where: { docTypeCode: registryCode('GY', docType) } });
        await app.prisma.docType.deleteMany({ where: { code: registryCode('GY', docType) } });
      });
    }
  });

  it('stored medical requirements never reach a checklist, while identity, police and trade gates remain required', async () => {
    const gy = await app.prisma.countryConfig.findUniqueOrThrow({ where: { code: 'GY' } });
    const stored = gy.documentChecklists as Record<string, string[]>;
    const medical = 'medical_certificate';
    await app.prisma.countryConfig.update({ where: { code: 'GY' }, data: { documentChecklists: {
      ...stored,
      MOVER: [medical], MOVER_NO_LICENCE: ['national_id', medical],
      MOVER_OPTIONAL: ['police_clearance', medical],
      VENDOR: ['business_registration', medical], VENDOR_UNREGISTERED: ['owner_national_id', medical],
      VENDOR_OPTIONAL: ['police_clearance', medical],
      SERVICE_PROVIDER: ['national_id', 'police_clearance', medical],
      SERVICE_PROVIDER_TRADE_ELECTRICIAN: ['gei_electrical_licence', medical],
    } } });
    try {
      const m = await rider();
      await app.prisma.serviceProvider.create({ data: { userId: m.userId, trade: 'ELECTRICIAN', portfolioPhotos: [] } });
      const country = new CountryConfigService(app.prisma);
      expect(await country.getDocumentChecklist('GY', 'VENDOR')).toEqual(['business_registration']);
      expect(await country.getDocumentChecklist('GY', 'VENDOR', 'UNREGISTERED')).toEqual(['owner_national_id']);
      expect(await country.getOptionalDocuments('GY', 'VENDOR', ['business_registration'])).toEqual(['police_clearance']);
      expect(await country.getMoverChecklist('GY', 'BICYCLE')).toEqual(['national_id']);
      expect(await country.getMoverOptionalDocuments('GY', 'BICYCLE')).toEqual(['police_clearance']);
      expect(await providerChecklist(app.prisma, m.userId)).toEqual(['national_id', 'police_clearance', 'gei_electrical_licence']);
      const status = await app.inject({ method: 'GET', url: '/api/v1/verification/status?role=MOVER', headers: { authorization: `Bearer ${m.token}` } });
      expect(status.statusCode).toBe(200);
      expect(status.json().data.checklist).toEqual(['national_id']);
      expect(status.json().data.optional).toEqual(['police_clearance']);
    } finally {
      await app.prisma.countryConfig.update({ where: { code: 'GY' }, data: { documentChecklists: stored } });
    }
  });

  const MEDICAL = /medic|health|doctor|physician|clinic|hospital/i;
  it('no checklist, category gate or registry type names a medical document', () => {
    const codes = new Set([
      ...Object.values(DEFAULT_DOCUMENT_CHECKLISTS).flat(),
      ...EXTRA_DOC_TYPES.map((t) => t.legacyCode),
      ...CATEGORY_GATES.map((g) => g.docType),
      ...Object.keys(BUCKET_OF),
      ...Object.keys(FIELD_CATALOGUE),
    ]);
    for (const code of codes) expect(code, code).not.toMatch(MEDICAL);
  });

  it('an upload of one is refused even if a list were edited to name it — no document is ever recorded', async () => {
    const gy = await app.prisma.countryConfig.findUniqueOrThrow({ where: { code: 'GY' } });
    const stored = gy.documentChecklists as Record<string, string[]>;
    await app.prisma.countryConfig.update({ where: { code: 'GY' }, data: { documentChecklists: { ...stored, MOVER: [...(stored['MOVER'] ?? []), 'medical_certificate'] } } });
    try {
      const m = await rider();
      const res = await app.inject({
        method: 'POST', url: '/api/v1/verification/documents', headers: { authorization: `Bearer ${m.token}` },
        payload: { role: 'MOVER', docType: 'medical_certificate', fileUrl: await ownedVerificationFixture(app.prisma, m.userId, 'medical'), consent: true, privacyNoticeVersion: 'v1' },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('DOC_TYPE_NOT_ACCEPTED');
      expect(await app.prisma.verificationDocument.count({ where: { userId: m.userId, docType: 'medical_certificate' } })).toBe(0);
      // ... and the registry never mints the type from that list.
      await system(() => seedDocRegistry(app.prisma));
      expect(await app.prisma.docType.count({ where: { code: registryCode('GY', 'medical_certificate') } })).toBe(0);
    } finally {
      await app.prisma.countryConfig.update({ where: { code: 'GY' }, data: { documentChecklists: stored } });
      // A run that failed (a mutation that let the type in) must not leave it behind for the next suite.
      const medical = registryCode('GY', 'medical_certificate');
      await system(async () => {
        await app.prisma.requirementItem.deleteMany({ where: { docTypeCode: medical } });
        await app.prisma.docField.deleteMany({ where: { docTypeCode: medical } });
        await app.prisma.docType.deleteMany({ where: { code: medical } });
      });
    }
  });

  it('a stored OPTIONAL list naming one never reaches the registry: the boot-time seed completes and mints or lists nothing for it', async () => {
    // The registry builds ONE requirement set per role from its required list AND its `<KEY>_OPTIONAL` list
    // (optional items are non-blocking). A medical type named in either must be skipped there too: a
    // requirement item for a type that was never minted is a foreign-key error inside the seed, which runs
    // at every boot — the API would not start.
    const gy = await app.prisma.countryConfig.findUniqueOrThrow({ where: { code: 'GY' } });
    const stored = gy.documentChecklists as Record<string, string[]>;
    const optional = [...(stored['MOVER_OPTIONAL'] ?? DEFAULT_DOCUMENT_CHECKLISTS['MOVER_OPTIONAL'] ?? [])];
    expect(optional.length, 'the movers keep an optional list to add the medical type to').toBeGreaterThan(0);
    const medical = registryCode('GY', 'medical_certificate');
    await app.prisma.countryConfig.update({ where: { code: 'GY' }, data: { documentChecklists: { ...stored, MOVER_OPTIONAL: [...optional, 'medical_certificate'] } } });
    try {
      await expect(system(() => seedDocRegistry(app.prisma))).resolves.toMatchObject({ docTypes: expect.any(Number) });
      expect(await app.prisma.docType.count({ where: { code: medical } })).toBe(0);
      expect(await app.prisma.requirementItem.count({ where: { docTypeCode: medical } })).toBe(0);
      // ... while every other document of that optional list is still in the movers' set.
      const items = await app.prisma.requirementItem.findMany({
        where: { requirementSet: { countryCode: 'GY', actorRole: 'MOVER', tier: REGISTRY_TIER, effectiveFrom: REGISTRY_EFFECTIVE_FROM } },
        select: { docTypeCode: true },
      });
      for (const code of optional) expect(items.map((i) => i.docTypeCode), code).toContain(registryCode('GY', code));
      // ... and an upload of it is still refused before anything is recorded (an optional type is otherwise submittable).
      const m = await rider();
      const res = await app.inject({
        method: 'POST', url: '/api/v1/verification/documents', headers: { authorization: `Bearer ${m.token}` },
        payload: { role: 'MOVER', docType: 'medical_certificate', fileUrl: await ownedVerificationFixture(app.prisma, m.userId, 'medical-optional'), consent: true, privacyNoticeVersion: 'v1' },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('DOC_TYPE_NOT_ACCEPTED');
      expect(await app.prisma.verificationDocument.count({ where: { userId: m.userId, docType: 'medical_certificate' } })).toBe(0);
    } finally {
      await app.prisma.countryConfig.update({ where: { code: 'GY' }, data: { documentChecklists: stored } });
      await system(async () => {
        await app.prisma.requirementItem.deleteMany({ where: { docTypeCode: medical } });
        await app.prisma.docField.deleteMany({ where: { docTypeCode: medical } });
        await app.prisma.docType.deleteMany({ where: { code: medical } });
      });
    }
  });
});
