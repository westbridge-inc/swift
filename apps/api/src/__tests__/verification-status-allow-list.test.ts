import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { registerErrorHandler } from '../middleware/error-handler';
import { registerEmptyJsonBodyParser } from '../plugins/empty-json';
import { verificationRoutes } from '../modules/verification/verification.routes';
import { runWithoutTenant } from '../plugins/tenant-context';
import { FRAUD_GENERIC_TEXT } from '../modules/verification/verification.service';
import { testPhone } from './helpers/fixture-ids';

// ---------------------------------------------------------------------------
// [SEC-PII · security scan 28 Oct 2026] GET /verification/status is the
// applicant's own view of their documents. It returned each document ROW whole:
// the reviewer's id, the legal-hold id, the provider reference, the stored file
// pointer, the policy facts the reviewer typed, and the raw review note, which
// for a confirmed fraud-class rejection names the reason code and carries the
// second reviewer's own words (which may name another account). The answer is
// now an explicit allow-list per document: id, docType, role, status, state,
// expiresAt, createdAt, replaced (when set) and `reviewNote` carrying only the
// reason meant for the applicant:
//   - a fraud-class rejection: the one generic text, never the code or the words;
//   - any other coded rejection: the reason text without the internal code;
//   - a withdrawn (revoked) document: a neutral line, the reviewer's reason stays staff-only.
// The phone (builds 9-12) and the web portal read docType, status, expiresAt,
// createdAt, replaced, reviewNote (and id on the web): all kept.
// ---------------------------------------------------------------------------

const RUN = nanoid(8).replace(/[^a-zA-Z0-9]/g, '0');
const DAY = 86_400_000;
const system = <T>(fn: () => Promise<T>) => runWithoutTenant(fn, 'verification-status-allow-list-test');
const ALLOWED = ['id', 'docType', 'role', 'status', 'state', 'expiresAt', 'createdAt', 'replaced', 'reviewNote'];
const OTHER_ACCOUNT = `acct-other-${RUN}`;
const SECRETS = {
  kycRef: `kyc-ref-${RUN}`,
  fileUrl: `verification/${RUN}/private-object.jpg`,
  policyNumber: `POL-${RUN}`,
  insurerName: `Insurer ${RUN}`,
  fraudWords: `Second reviewer: same licence number as ${OTHER_ACCOUNT}`,
  revokeWords: `Revoked after a call with ${OTHER_ACCOUNT}`,
};

let app: FastifyInstance;
let token = '';
let userId = '';
let reviewerId = '';
let holdId = '';
const docs: Record<string, string> = {};
let checklist: string[] = [];

async function status() {
  const res = await app.inject({ method: 'GET', url: '/api/v1/verification/status?role=MOVER', headers: { authorization: `Bearer ${token}` } });
  expect(res.statusCode).toBe(200);
  return res;
}

beforeAll(async () => {
  app = Fastify({ logger: false });
  registerErrorHandler(app); registerEmptyJsonBodyParser(app);
  await app.register(prismaPlugin); await app.register(redisPlugin); await app.register(authPlugin); await app.register(socketPlugin);
  await app.register(verificationRoutes, { prefix: '/api/v1/verification' });
  await app.ready();

  const reviewer = await system(() => app.prisma.user.create({ data: {
    phone: testPhone(), firstName: 'Review', lastName: `R${RUN}`, roles: ['ADMIN', 'CUSTOMER'] as never, activeRole: 'ADMIN' as never, status: 'ACTIVE', isPhoneVerified: true,
  } as never }));
  reviewerId = reviewer.id;
  const user = await system(() => app.prisma.user.create({ data: {
    phone: testPhone(), firstName: 'Apply', lastName: `A${RUN}`, roles: ['RIDER', 'CUSTOMER'] as never, activeRole: 'RIDER' as never, status: 'ACTIVE', isPhoneVerified: true,
  } as never }));
  userId = user.id;
  await system(() => app.prisma.rider.create({ data: { userId, riderType: 'DELIVERY', vehicleType: 'MOTORCYCLE' } as never }));
  token = app.jwt.sign({ userId, role: 'RIDER', jti: nanoid(8) });
  await system(() => app.prisma.session.create({ data: {
    userId, token, refreshToken: nanoid(48), authMethod: 'OTP', deviceId: `vs-${RUN}`, deviceType: 'test', expiresAt: new Date(Date.now() + DAY),
  } }));

  const first = (await status()).json().data;
  // The mover's required documents (then any they may add): the withdrawn one and a later approved copy share a type.
  checklist = [...(first.checklist as string[]), ...(first.optional as string[])];
  expect(checklist.length).toBeGreaterThanOrEqual(3);
  holdId = (await system(() => app.prisma.docLegalHold.create({ data: {
    subjectUserId: userId, reason: 'fraud confirmation (test)', ownerId: reviewerId, placedBy: reviewerId, reviewBy: new Date(Date.now() + 90 * DAY),
  } }))).id;
  const make = (docType: string, data: Record<string, unknown>) => system(() => app.prisma.verificationDocument.create({ data: {
    userId, role: 'MOVER', docType, fileUrl: SECRETS.fileUrl, kycRef: SECRETS.kycRef, reviewedBy: reviewerId, reviewedAt: new Date(),
    insurerName: SECRETS.insurerName, policyNumber: SECRETS.policyNumber, consentAt: new Date(), privacyNoticeVersion: `pn-${RUN}`,
    ...data,
  } as never }));
  docs['fraud'] = (await make(checklist[0]!, {
    status: 'REJECTED', state: 'REJECTED', legalHoldId: holdId, reviewNote: `[DUPLICATE] ${FRAUD_GENERIC_TEXT} ${SECRETS.fraudWords}`,
  })).id;
  docs['ordinary'] = (await make(checklist[1]!, {
    status: 'REJECTED', state: 'REJECTED', reviewNote: '[UNREADABLE] The photo is too blurry or dark to read — retake it in good light. The top corner is cut off.',
  })).id;
  docs['revoked'] = (await make(checklist[2]!, { status: 'REJECTED', state: 'REVOKED', reviewNote: `REVOKED: ${SECRETS.revokeWords}` })).id;
  docs['approved'] = (await make(checklist[2]!, { status: 'APPROVED', state: 'COMMITTED', expiresAt: new Date(Date.now() + 200 * DAY) })).id;
});

afterAll(async () => {
  await system(async () => {
    await app.prisma.verificationDocument.deleteMany({ where: { userId } });
    await app.prisma.docLegalHold.deleteMany({ where: { subjectUserId: userId } });
    await app.prisma.session.deleteMany({ where: { userId } });
    await app.prisma.rider.deleteMany({ where: { userId } });
    await app.prisma.user.deleteMany({ where: { id: { in: [userId, reviewerId] } } });
  });
  await app.close();
});

describe('[SEC-PII] GET /verification/status returns only what the applicant may see', () => {
  type Doc = Record<string, unknown> & { id: string; reviewNote: string | null };
  const byId = async () => new Map(((await status()).json().data.documents as Doc[]).map((d) => [d.id, d]));

  it('each document carries only the allow-listed fields', async () => {
    const documents = (await status()).json().data.documents as Doc[];
    expect(documents.length).toBe(4);
    for (const document of documents) {
      for (const key of Object.keys(document)) expect(ALLOWED, key).toContain(key);
    }
  });

  it('no reviewer id, legal hold, provider reference, file pointer or typed policy facts in the answer', async () => {
    const payload = (await status()).payload;
    for (const secret of [reviewerId, holdId, SECRETS.kycRef, SECRETS.fileUrl, SECRETS.policyNumber, SECRETS.insurerName, `pn-${RUN}`]) {
      expect(payload, secret).not.toContain(secret);
    }
  });

  it('a fraud-class rejection reads only the generic text: no code, no reviewer words, nothing naming another account', async () => {
    const payload = (await status()).payload;
    expect(payload).not.toContain(OTHER_ACCOUNT);
    expect(payload).not.toContain('[DUPLICATE]');
    expect(payload).not.toContain('Second reviewer');
    const fraud = (await byId()).get(docs['fraud']!)!;
    expect(fraud.reviewNote).toBe(FRAUD_GENERIC_TEXT);
    expect(fraud).toMatchObject({ status: 'REJECTED', docType: checklist[0] });
  });

  it('an ordinary rejection keeps the reason the applicant was given, without the internal code', async () => {
    const ordinary = (await byId()).get(docs['ordinary']!)!;
    expect(ordinary.reviewNote).toBe('The photo is too blurry or dark to read — retake it in good light. The top corner is cut off.');
  });

  it('a withdrawn document reads a neutral line; the reviewer\'s reason stays with staff', async () => {
    const revoked = (await byId()).get(docs['revoked']!)!;
    expect(revoked.reviewNote).toBe('Withdrawn by our team');
    expect(revoked['status']).toBe('REJECTED');
  });

  it('the fields the phone (builds 9-12) and the web portal read are all still there', async () => {
    const approved = (await byId()).get(docs['approved']!)!;
    expect(approved).toMatchObject({ id: docs['approved'], docType: checklist[2], role: 'MOVER', status: 'APPROVED', state: 'COMMITTED', reviewNote: null });
    expect(typeof approved['createdAt']).toBe('string');
    expect(typeof approved['expiresAt']).toBe('string');
    const body = (await status()).json().data;
    // The rest of the status answer is unchanged in shape.
    for (const key of ['roleKey', 'checklist', 'optional', 'documents', 'missing', 'roleVerified']) expect(body, key).toHaveProperty(key);
    expect(body.missing).toEqual(expect.arrayContaining([checklist[0], checklist[1]]));
    expect(body.missing).not.toContain(checklist[2]);
  });
});
