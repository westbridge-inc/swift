import { ownedVerificationFixture, signupSelfieFixture } from './helpers/verification-object';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { runWithTenant } from '../plugins/tenant-context';
import { authRoutes } from '../modules/auth/auth.routes';
import { verificationRoutes } from '../modules/verification/verification.routes';
import { registerErrorHandler } from '../middleware/error-handler';
import { VerificationService, isPoliceCleared } from '../modules/verification/verification.service';
import { NotificationService } from '../modules/notification/notification.service';
import { SandboxKycProvider } from '../providers/kyc/kyc-provider';
import { refusalGround } from '../modules/verification/dsar';
import { homeVisitsCleared } from '../modules/verification/home-visits';
import {
  POLICE_CLEARANCE_TICK, policeClearanceConsentFor, policeClearanceKind,
} from '../modules/verification/police-clearance-consent';
import { registrationProofFor } from './helpers/otp';

// ---------------------------------------------------------------------------
// [POLICE-CLEARANCE CONSENT · owner 25 Oct 2026 · DPA s.2 + s.9(1)(a), legal research D1/D2, Privacy s.3]
// A police clearance (a criminal record: sensitive data) is uploaded only with its OWN explicit consent, in words
// that are true: what Swift records (whether it was clear and its issue date), when the image goes (the retention
// settings, read when the words are shown), and that the person can withdraw it at any time. A taxi driver's is
// optional; a home-visit provider's is needed for home visits, and the words say why. The words are their own
// versioned document in the consent ledger (police_clearance_consent); a version names the days it promises.
// Withdrawing erases the clearance even while the account is active (the DSAR "active licence" refusal does not
// apply to a consent-based document), keeps only a note, and records the withdrawal in the ledger.
// ---------------------------------------------------------------------------

const runBase = 592_089_100_000 + Math.floor(Math.random() * 800_000);
const PHONES = { taxi: `+${runBase + 1}`, words: `+${runBase + 2}`, admin: `+${runBase + 3}`, old: `+${runBase + 4}` };
const ALL_PHONES = Object.values(PHONES);

let app: FastifyInstance;
let service: VerificationService;
let adminId = '';

function inject(method: 'GET' | 'POST', url: string, payload?: Record<string, unknown>, token?: string) {
  return app.inject({
    method, url, ...(payload !== undefined ? { payload } : {}),
    headers: { ...(payload !== undefined ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
  });
}

async function taxiDriver(phone: string) {
  const registrationProof = await registrationProofFor(app, phone);
  const res = await inject('POST', '/api/v1/auth/register', { acceptTerms: true, phone, registrationProof, firstName: 'Police', lastName: 'Consent', role: 'MOVER' });
  expect(res.statusCode, res.body).toBe(201);
  const data = res.json().data as { user: { id: string }; tokens: { accessToken: string } };
  await signupSelfieFixture(app.prisma, data.user.id);
  await app.prisma.driver.create({ data: {
    userId: data.user.id, vehicleMake: 'Toyota', vehicleModel: 'Allion', vehicleYear: 2020, vehicleColor: 'Silver',
    licensePlate: `HC-${Math.floor(100000 + Math.random() * 899999)}`, driverLicenseUrl: 'storage://t/dl.jpg', vehicleInsuranceUrl: 'storage://t/ins.jpg',
  } });
  return { userId: data.user.id, token: data.tokens.accessToken };
}

async function cleanup() {
  const users = await app.prisma.user.findMany({ where: { phone: { in: ALL_PHONES } }, select: { id: true } });
  const ids = users.map((u) => u.id);
  if (ids.length) {
    const docs = await app.prisma.verificationDocument.findMany({ where: { userId: { in: ids } }, select: { id: true } });
    await app.prisma.reviewDecision.deleteMany({ where: { case: { submissionId: { in: docs.map((d) => d.id) } } } });
    await app.prisma.reviewCase.deleteMany({ where: { submissionId: { in: docs.map((d) => d.id) } } });
    await app.prisma.notification.deleteMany({ where: { userId: { in: ids } } });
    await app.prisma.user.deleteMany({ where: { id: { in: ids } } });
  }
}

const status = async (token: string) => {
  const res = await inject('GET', '/api/v1/verification/status?role=MOVER&vehicleType=CAR', undefined, token);
  expect(res.statusCode, res.body).toBe(200);
  return res.json().data as {
    optional: string[];
    documents: Array<{ id: string; docType: string; status: string }>;
    policeClearanceConsent?: { tick: string; version: string; text: string; withdrawConfirm: string } | null;
  };
};

const uploadPolice = async (who: { userId: string; token: string }, marker: string, consent: Record<string, unknown>) => inject('POST', '/api/v1/verification/documents', {
  role: 'MOVER', docType: 'police_clearance', fileUrl: await ownedVerificationFixture(app.prisma, who.userId, marker),
  consent: true, privacyNoticeVersion: 'v1', ...consent,
}, who.token);

const policeRows = (userId: string) => app.prisma.consentRecord.findMany({
  where: { subjectId: userId, documentType: 'police_clearance_consent' }, orderBy: { capturedAt: 'asc' },
});

/** A settings reader that answers the two retention days, or nothing (the defaults). */
const settings = (days: Record<string, number> = {}) => ({
  platformConfig: { findUnique: async ({ where }: { where: { key: string } }) => (where.key in days ? { value: days[where.key] } : null) },
}) as never;

beforeAll(async () => {
  process.env['DATABASE_URL'] = process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift';
  process.env['REDIS_URL'] = process.env['REDIS_URL'] || 'redis://localhost:6382';
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  await app.register(authRoutes, { prefix: '/api/v1/auth' });
  await app.register(verificationRoutes, { prefix: '/api/v1/verification' });
  await app.ready();
  await cleanup();
  for (const phone of ALL_PHONES) {
    await app.redis.del(`otp:${phone}`, `otp_rate:${phone}`, `otp_attempt:${phone}`, `otp_verified:${phone}`);
  }
  service = new VerificationService(app.prisma, new NotificationService(app.prisma, app.io), new SandboxKycProvider());
  const admin = await runWithTenant('swift-default', () => app.prisma.user.create({ data: {
    phone: PHONES.admin, firstName: 'Police', lastName: 'Reviewer', roles: ['SUPER_ADMIN', 'CUSTOMER'], activeRole: 'SUPER_ADMIN', status: 'ACTIVE', isPhoneVerified: true,
  } }));
  adminId = admin.id;
});

afterAll(async () => {
  await cleanup();
  await app.close();
});

describe('[POLICE-CLEARANCE] its own words, true when shown', () => {
  it('a taxi driver\'s are optional; a home-visit provider\'s say why; other checklists have none', async () => {
    expect(policeClearanceKind('MOVER')).toBe('taxi');
    expect(policeClearanceKind('SERVICE')).toBe('home');
    expect(policeClearanceKind('SERVICE_PROVIDER')).toBe('home');
    for (const role of ['RESTAURANT', 'SUPERMARKET', 'STORE']) expect(policeClearanceKind(role), role).toBeNull();

    const taxi = await policeClearanceConsentFor(settings(), 'MOVER');
    expect(taxi).toMatchObject({ tick: POLICE_CLEARANCE_TICK, kind: 'taxi', version: 'taxi-v1-30d' });
    expect(taxi!.text).toBe('Optional. I choose to upload my police clearance. A person at Swift checks it and records only whether it was clear and the date it was issued. Swift deletes the image within 31 days of that check. I can withdraw it at any time; Swift then deletes it and keeps only a note that it was withdrawn. Swift keeps more only where the law requires.');
    const home = await policeClearanceConsentFor(settings(), 'SERVICE');
    expect(home).toMatchObject({ kind: 'home', version: 'home-v1-30d' });
    expect(home!.text).toBe('Needed because I will visit customers\' homes. I choose to upload my police clearance. A person at Swift checks it and records only whether it was clear and the date it was issued. Swift deletes the image within 31 days of that check. I can withdraw it at any time; Swift then deletes it, keeps only a note that it was withdrawn, and pauses my home visits until a new one is approved. Swift keeps more only where the law requires.');
    expect(await policeClearanceConsentFor(settings(), 'RESTAURANT')).toBeNull();
  });

  it('the days follow the retention settings (the longer of the image and the rejected-document windows), and new days are new words', async () => {
    const longer = await policeClearanceConsentFor(settings({ 'documents.personal_image_days': 45, 'documents.rejected_document_days': 20 }), 'MOVER');
    expect(longer).toMatchObject({ version: 'taxi-v1-45d' });
    expect(longer!.text).toContain('within 46 days of that check');
    const rejected = await policeClearanceConsentFor(settings({ 'documents.rejected_document_days': 60 }), 'SERVICE_PROVIDER');
    expect(rejected).toMatchObject({ version: 'home-v1-60d' });
    expect(rejected!.text).toContain('within 61 days of that check');
    // A value the sweeps ignore (outside 1..3650) is not promised either: the default stands.
    expect(await policeClearanceConsentFor(settings({ 'documents.personal_image_days': 0 }), 'MOVER')).toMatchObject({ version: 'taxi-v1-30d' });
  });

  it('GET /verification/status carries the words and the withdrawal confirmation for a taxi driver', async () => {
    const driver = await taxiDriver(PHONES.words);
    const s = await status(driver.token);
    expect(s.optional).toContain('police_clearance');
    expect(s.policeClearanceConsent).toMatchObject({ tick: POLICE_CLEARANCE_TICK, version: 'taxi-v1-30d' });
    expect(s.policeClearanceConsent!.text).toMatch(/^Optional\. I choose to upload my police clearance\./);
    expect(s.policeClearanceConsent!.withdrawConfirm).toBe('Swift deletes your police clearance now and keeps only a note that it was withdrawn. Your account is no longer recorded as police-cleared.');
  });
});

describe('[POLICE-CLEARANCE] the upload records its own consent; a withdrawal erases it', () => {
  it('upload with the police tick → its own ledger row anchored to the words; wrong words or the wrong document are refused', async () => {
    const driver = await taxiDriver(PHONES.taxi);
    const words = (await status(driver.token)).policeClearanceConsent!;
    const docs = () => app.prisma.verificationDocument.count({ where: { userId: driver.userId } });

    const stale = await uploadPolice(driver, 'pc-stale', { consentTick: POLICE_CLEARANCE_TICK, consentVersion: 'taxi-v1-29d' });
    expect(stale.statusCode, stale.body).toBe(409);
    expect(stale.json().error.code).toBe('CONSENT_WORDS_CHANGED');
    const wrongDoc = await inject('POST', '/api/v1/verification/documents', {
      role: 'MOVER', docType: 'drivers_licence', fileUrl: await ownedVerificationFixture(app.prisma, driver.userId, 'pc-wrong-doc'),
      consent: true, privacyNoticeVersion: 'v1', consentTick: POLICE_CLEARANCE_TICK, consentVersion: words.version,
    }, driver.token);
    expect(wrongDoc.statusCode).toBe(400);
    expect(wrongDoc.json().error.code).toBe('CONSENT_TICK_MISMATCH');
    expect(await docs()).toBe(0);
    expect(await policeRows(driver.userId)).toHaveLength(0);

    const ok = await uploadPolice(driver, 'pc-ok', { consentTick: POLICE_CLEARANCE_TICK, consentVersion: words.version });
    expect(ok.statusCode, ok.body).toBe(201);
    const rows = await policeRows(driver.userId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ subjectType: 'driver', documentVersion: 'taxi-v1-30d', action: 'granted', evidence: { control: 'police_clearance_checkbox', docType: 'police_clearance' } });
    const doc = await app.prisma.legalDocument.findUniqueOrThrow({
      where: { documentType_version_locale: { documentType: 'police_clearance_consent', version: 'taxi-v1-30d', locale: 'en-GY' } },
    });
    expect(doc.renderedText).toBe(words.text);
    // The generic document tick is not recorded for it.
    expect(await app.prisma.consentRecord.count({ where: { subjectId: driver.userId, documentType: 'document_processing_consent' } })).toBe(0);

    // Approved, it makes the account police-cleared …
    const uploaded = await app.prisma.verificationDocument.findFirstOrThrow({ where: { userId: driver.userId, docType: 'police_clearance' } });
    await runWithTenant('swift-default', () => service.approveDocument(uploaded.id, adminId, new Date(Date.now() + 200 * 86_400_000)));
    expect(await isPoliceCleared(app.prisma, driver.userId)).toBe(true);
    expect(await homeVisitsCleared(app.prisma, driver.userId), 'the same evidence opens home visits').toBe(true);

    // … and withdrawing it while the account is active erases it now, keeps only a note, and says so in the ledger.
    const withdrawn = await inject('POST', '/api/v1/verification/police-clearance/withdraw', { role: 'MOVER' }, driver.token);
    expect(withdrawn.statusCode, withdrawn.body).toBe(200);
    expect(withdrawn.json().data).toEqual({ withdrawn: 1, kept: 0 });
    expect(await isPoliceCleared(app.prisma, driver.userId)).toBe(false);
    expect(await homeVisitsCleared(app.prisma, driver.userId), 'home visits pause').toBe(false);
    const after = await app.prisma.verificationDocument.findUniqueOrThrow({ where: { id: uploaded.id } });
    expect(after.purgedAt).toBeInstanceOf(Date);
    expect(after.fileUrl).toBe('');
    // Revoked first (its record follows), then purged: the document ends PURGED, the record REVOKED with no dates.
    expect(after.state).toBe('PURGED');
    expect(after.status).toBe('REJECTED');
    expect(after.reviewNote).toBe('WITHDRAWN: by the person');
    expect(after.expiresAt).toBeNull();
    const record = await app.prisma.documentRecord.findUniqueOrThrow({ where: { submissionId: uploaded.id } });
    expect(record).toMatchObject({ status: 'REVOKED', issuedOn: null, expiresOn: null });
    expect(await app.prisma.deletionReceipt.count({ where: { submissionId: uploaded.id } })).toBeGreaterThan(0);
    const ledger = await policeRows(driver.userId);
    expect(ledger.map((r) => r.action)).toEqual(['granted', 'withdrawn']);
    expect(ledger[1]).toMatchObject({ subjectType: 'driver', evidence: { control: 'police_clearance_withdrawn' } });
    // The checklist no longer shows a withdrawn clearance (it is not "Rejected"); a new one can be added.
    expect((await status(driver.token)).documents.filter((d) => d.docType === 'police_clearance')).toEqual([]);

    // Nothing left to withdraw: nothing happens and nothing is recorded.
    const again = await inject('POST', '/api/v1/verification/police-clearance/withdraw', { role: 'MOVER' }, driver.token);
    expect(again.json().data).toEqual({ withdrawn: 0, kept: 0 });
    expect(await policeRows(driver.userId)).toHaveLength(2);
    // A checklist with no police clearance has nothing to withdraw.
    const notHere = await inject('POST', '/api/v1/verification/police-clearance/withdraw', { role: 'RESTAURANT' }, driver.token);
    expect(notHere.statusCode).toBe(400);
  });

  it('build 12 still uploads a police clearance with the generic document tick (no new words in its JS)', async () => {
    const driver = await taxiDriver(PHONES.old);
    const res = await uploadPolice(driver, 'pc-build12', { consentTick: 'document_v1' });
    expect(res.statusCode, res.body).toBe(201);
    expect(await app.prisma.consentRecord.count({ where: { subjectId: driver.userId, documentType: 'document_processing_consent' } })).toBe(1);
  });
});

describe('[POLICE-CLEARANCE] DSAR erasure: a consent-based document is not an "active licence"', () => {
  it('an approved police clearance can be erased while the account is live; an approved licence still cannot; a legal hold still wins', () => {
    const live = { held: false, amlRecord: false, approved: true, relationshipLive: true };
    expect(refusalGround({ ...live, docType: 'police_clearance' })).toBeNull();
    expect(refusalGround({ ...live, docType: 'drivers_licence' })).toBe('ACTIVE_LICENCE');
    expect(refusalGround({ ...live, docType: 'police_clearance', held: true })).toBe('LEGAL_HOLD');
  });
});
