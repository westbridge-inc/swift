import { ownedVerificationFixture, signupSelfieFixture } from './helpers/verification-object';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { authRoutes } from '../modules/auth/auth.routes';
import { verificationRoutes } from '../modules/verification/verification.routes';
import { registerErrorHandler } from '../middleware/error-handler';
import { hashDocument, publishLegalDocument, recordConsent } from '../modules/legal/consent.service';
import { UPLOAD_CONSENT } from '../modules/verification/upload-consent';
import { documentConsentOnRecord } from '../modules/verification/document-consent-record';
import { registrationProofFor } from './helpers/otp';

// ---------------------------------------------------------------------------
// [DOC-CONSENT · owner 25 Oct 2026, iPhone build 12 on staging] "The 'I consent to Swift processing this document'
// tick in the upload documents screen for riders and drivers keeps coming off by itself."
//
// The tick lived only on the screen (useState(false)) and the API never said what the ledger already held, so
// every new visit showed it unticked although each upload had recorded the person's consent. GET
// /verification/status now says whether THIS person's latest ledger row for THESE words is a grant
// (`documentConsent`), so the checklist can show their own recorded choice. It is never true without a grant
// they gave: no row, an upload without the tick (builds 9-11), a withdrawal, other words, or another subject's
// row all read as not given, and reading writes nothing.
// ---------------------------------------------------------------------------

const runBase = 592_089_000_000 + Math.floor(Math.random() * 900_000);
const PHONES = { ticked: `+${runBase + 1}`, plain: `+${runBase + 2}`, words: `+${runBase + 3}`, subject: `+${runBase + 4}` };
const ALL_PHONES = Object.values(PHONES);
const WORDS = UPLOAD_CONSENT.document_v1;

let app: FastifyInstance;

function inject(method: 'GET' | 'POST', url: string, payload?: Record<string, unknown>, token?: string) {
  return app.inject({
    method,
    url,
    ...(payload !== undefined ? { payload } : {}),
    headers: { ...(payload !== undefined ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
  });
}

async function signup(phone: string) {
  const registrationProof = await registrationProofFor(app, phone);
  const res = await inject('POST', '/api/v1/auth/register', {
    acceptTerms: true, phone, registrationProof, firstName: 'DocConsent', lastName: 'Mover', role: 'MOVER',
  });
  expect(res.statusCode, res.body).toBe(201);
  const data = res.json().data as { user: { id: string }; tokens: { accessToken: string } };
  await signupSelfieFixture(app.prisma, data.user.id);
  await app.prisma.rider.create({ data: { userId: data.user.id, riderType: 'DELIVERY', vehicleType: 'MOTORCYCLE' } });
  return { userId: data.user.id, token: data.tokens.accessToken };
}

async function cleanup() {
  const users = await app.prisma.user.findMany({ where: { phone: { in: ALL_PHONES } }, select: { id: true } });
  const ids = users.map((u) => u.id);
  if (ids.length) {
    await app.prisma.notification.deleteMany({ where: { userId: { in: ids } } });
    await app.prisma.user.deleteMany({ where: { id: { in: ids } } });
  }
}

const status = async (token: string, query = 'role=MOVER') => {
  const res = await inject('GET', `/api/v1/verification/status?${query}`, undefined, token);
  expect(res.statusCode, res.body).toBe(200);
  return res.json().data as { documentConsent?: unknown };
};

const upload = async (who: { userId: string; token: string }, marker: string, tick: boolean) => {
  const res = await inject('POST', '/api/v1/verification/documents', {
    role: 'MOVER', docType: 'drivers_licence', fileUrl: await ownedVerificationFixture(app.prisma, who.userId, marker),
    consent: true, privacyNoticeVersion: 'v1', ...(tick ? { consentTick: 'document_v1' } : {}),
  }, who.token);
  expect(res.statusCode, res.body).toBe(201);
};

const ledgerCount = (userId: string) => app.prisma.consentRecord.count({ where: { subjectId: userId } });

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
});

afterAll(async () => {
  await cleanup();
  await app.close();
});

describe('[DOC-CONSENT] GET /verification/status says whether the document tick is on record', () => {
  it('a person who ticked and uploaded is shown as having given it, from their own ledger row — on every read', async () => {
    const mover = await signup(PHONES.ticked);
    expect((await status(mover.token)).documentConsent).toEqual({ tick: 'document_v1', given: false, givenAt: null });

    await upload(mover, 'doc-consent-ticked', true);
    const row = await app.prisma.consentRecord.findFirstOrThrow({
      where: { subjectType: 'driver', subjectId: mover.userId, documentType: WORDS.documentType },
      orderBy: { capturedAt: 'desc' },
    });
    const expected = { tick: 'document_v1', given: true, givenAt: row.capturedAt.toISOString() };
    expect((await status(mover.token)).documentConsent).toEqual(expected);
    // The onboarding screen reads the checklist for the vehicle being picked: the same record answers.
    expect((await status(mover.token, 'role=MOVER&vehicleType=CAR')).documentConsent).toEqual(expected);

    // Reading writes nothing: no ledger row is made by showing the record.
    const rows = await ledgerCount(mover.userId);
    await status(mover.token);
    await status(mover.token);
    expect(await ledgerCount(mover.userId)).toBe(rows);
  });

  it('an upload without the tick (builds 9-11) records nothing, so nothing is shown as given', async () => {
    const mover = await signup(PHONES.plain);
    await upload(mover, 'doc-consent-plain', false);
    expect((await status(mover.token)).documentConsent).toEqual({ tick: 'document_v1', given: false, givenAt: null });
  });

  it('the latest row decides: a withdrawal is not given, a re-grant is; a grant to other words is not', async () => {
    const mover = await signup(PHONES.words);
    await upload(mover, 'doc-consent-words', true);
    expect((await status(mover.token)).documentConsent).toMatchObject({ given: true });

    const append = (action: 'withdrawn' | 're_granted', version = WORDS.version) => app.prisma.$transaction((tx) => recordConsent(tx, {
      subjectType: 'driver', subjectId: mover.userId, documentType: WORDS.documentType, version, action, surface: 'ios',
      evidence: { control: 'doc_consent_test' },
    }));
    await append('withdrawn');
    expect((await status(mover.token)).documentConsent).toEqual({ tick: 'document_v1', given: false, givenAt: null });
    await append('re_granted');
    expect((await status(mover.token)).documentConsent).toMatchObject({ given: true });

    // Consent to other words is not consent to these words.
    const otherVersion = `vT-docconsent-${runBase}`;
    await publishLegalDocument(app.prisma, { documentType: WORDS.documentType, version: otherVersion, renderedText: `Other words ${runBase}.` });
    await app.prisma.$transaction((tx) => recordConsent(tx, {
      subjectType: 'driver', subjectId: mover.userId, documentType: WORDS.documentType, version: otherVersion, action: 'granted', surface: 'ios',
      evidence: { control: 'doc_consent_test' },
    }));
    expect((await status(mover.token)).documentConsent).toEqual({ tick: 'document_v1', given: false, givenAt: null });

    // Both anchors count on their own: a row naming v1 over other words' hash, or these words' hash under another
    // version, is not a grant to these words (rows the app never writes; written raw to prove each check).
    const raw = (documentVersion: string, documentContentHash: string) => app.prisma.consentRecord.create({ data: {
      subjectType: 'driver', subjectId: mover.userId, documentType: WORDS.documentType, documentVersion, documentContentHash,
      action: 'granted', surface: 'ios', evidence: { control: 'doc_consent_test' },
    } });
    await append('re_granted');
    expect((await status(mover.token)).documentConsent).toMatchObject({ given: true });
    await raw(WORDS.version, hashDocument(`Other words ${runBase}.`));
    expect((await status(mover.token)).documentConsent).toMatchObject({ given: false });
    await append('re_granted');
    expect((await status(mover.token)).documentConsent).toMatchObject({ given: true });
    await raw(otherVersion, hashDocument(WORDS.text));
    expect((await status(mover.token)).documentConsent).toMatchObject({ given: false });
  });

  it('the record belongs to the subject the upload recorded: a mover\'s tick is not shown on a business checklist', async () => {
    const mover = await signup(PHONES.subject);
    await upload(mover, 'doc-consent-subject', true);
    expect(await documentConsentOnRecord(app.prisma, mover.userId, 'MOVER')).toMatchObject({ given: true });
    for (const role of ['RESTAURANT', 'SUPERMARKET', 'STORE', 'SERVICE', 'SERVICE_PROVIDER']) {
      expect(await documentConsentOnRecord(app.prisma, mover.userId, role), role).toEqual({ tick: 'document_v1', given: false, givenAt: null });
    }
  });
});
