import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { registerErrorHandler } from '../middleware/error-handler';
import { registerEmptyJsonBodyParser } from '../plugins/empty-json';
import { adminRoutes } from '../modules/admin/admin.routes';
import { runWithoutTenant } from '../plugins/tenant-context';
import { ADMIN_ROUTE_AUTHORITY, DOC_REVIEWER_CAPABILITIES, DOCUMENT_REVIEWER_CAPABILITY } from '../modules/admin/admin-authority';
import { purgeFixtureAuditTrail } from './helpers/audit-fixture-purge';
import { testPhone, wordFreeTag } from './helpers/fixture-ids';

// ---------------------------------------------------------------------------
// [DOC-SECURITY G3] THE REVIEW QUEUE IS A DOCUMENT REVIEWER'S, AND SAYS ONLY
// WHAT THE REVIEW CENTER SHOWS.
//
// GET /admin/verification/queue answered any admin holding `*` (every ADMIN
// row says `*`) with the whole document row: the storage key of the file, the
// provider reference, the insurer and policy number a reviewer typed, the
// reviewer's own note, the applicant's full phone number — and it left no
// record of who read it.
//
// The queue is now:
//   - behind the document reviewer grant (`documents.review`), which `*`, a
//     prefix and a role default never confer — the same door as opening the
//     file, because the queue IS the list of people's identity papers;
//   - a sensitive read (C1), so every successful read leaves an access row;
//   - an allow-list of the fields the Review Center uses, and the applicant's
//     number always masked (the full number is the person page's audited
//     reveal, never a queue row).
// ---------------------------------------------------------------------------

const RUN = wordFreeTag(8);
const DAY = 86_400_000;
const system = <T>(fn: () => Promise<T>) => runWithoutTenant(fn, 'verification-queue-minimal-test');

/** Every field a queue row may carry, and nothing else. */
const ROW_FIELDS = [
  'consentAt', 'createdAt', 'docType', 'expiresAt', 'id', 'previousDecision', 'privacyNoticeVersion',
  'reviewedBy', 'reviewerTypes', 'role', 'status', 'user', 'userId',
].sort();
const USER_FIELDS = ['countryCode', 'driver', 'firstName', 'id', 'lastName', 'phone'].sort();
const DRIVER_FIELDS = ['licensePlate', 'vehicleMake', 'vehicleModel', 'vehicleType'].sort();

let app: FastifyInstance;
const userIds: string[] = [];
const tokens: Record<string, string> = {};
const applicantPhone = testPhone();
const secrets = {
  fileKey: '',
  kycRef: `KYCREF${RUN}`,
  insurer: `Insurer${RUN}`,
  policy: `POLICY${RUN}`,
  ownNote: `OwnNote${RUN}`,
  earlierNote: `The photo was blurred ${RUN}`,
  legacyPointer: `legacy-pointer-${RUN}`,
};
const ids = { applicant: '', pending: '', earlier: '' };

async function person(phone: string, roles: string[], extra: Record<string, unknown> = {}) {
  const u = await system(() => app.prisma.user.create({ data: {
    phone, firstName: `Queue${RUN}`, lastName: 'Applicant', roles: roles as never, activeRole: roles[0] as never,
    countryCode: 'GY', status: 'ACTIVE', isPhoneVerified: true, ...extra,
  } as never }));
  userIds.push(u.id);
  return u.id;
}
async function adminWith(name: string, role: 'ADMIN' | 'SUPER_ADMIN', permissions: readonly string[]) {
  const id = await person(testPhone(), [role, 'CUSTOMER'], { firstName: 'Staff', admin: { create: { permissions: [...permissions] } } });
  const token = app.jwt.sign({ userId: id, role, jti: nanoid(8) });
  await system(() => app.prisma.session.create({ data: {
    userId: id, token, refreshToken: nanoid(48), authMethod: 'OTP', deviceId: `vqm-${RUN}-${name}`, deviceType: 'test', expiresAt: new Date(Date.now() + DAY),
  } }));
  tokens[name] = token;
  return id;
}
const queue = (token: string, query = 'status=PENDING&role=all&limit=100') =>
  app.inject({ method: 'GET', url: `/api/v1/admin/verification/queue?${query}`, headers: { authorization: `Bearer ${token}` } });

/** The onResponse hook writes the access row after inject() resolves: wait for it, bounded. */
async function readRowsFor(actorUserId: string, atLeast: number) {
  const deadline = Date.now() + 10_000;
  let rows = await system(() => app.prisma.sensitiveReadLog.findMany({ where: { actorUserId, action: 'GET /verification/queue' } }));
  while (rows.length < atLeast && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 25));
    rows = await system(() => app.prisma.sensitiveReadLog.findMany({ where: { actorUserId, action: 'GET /verification/queue' } }));
  }
  return rows;
}

beforeAll(async () => {
  app = Fastify({ logger: false });
  registerErrorHandler(app); registerEmptyJsonBodyParser(app);
  await app.register(prismaPlugin); await app.register(redisPlugin); await app.register(authPlugin); await app.register(socketPlugin);
  await app.register(adminRoutes, { prefix: '/api/v1/admin' });
  await app.ready();

  ids.applicant = await person(applicantPhone, ['DRIVER', 'CUSTOMER']);
  await system(() => app.prisma.driver.create({ data: {
    userId: ids.applicant, vehicleMake: 'Toyota', vehicleModel: 'Axio', vehicleYear: 2016, vehicleColor: 'White', licensePlate: `HC${RUN.slice(0, 4)}`,
    driverLicenseUrl: secrets.legacyPointer, vehicleInsuranceUrl: secrets.legacyPointer,
  } }));
  secrets.fileKey = `verification/${ids.applicant}/${RUN}queue.enc`;
  // An earlier insurance document, rejected with the reviewer's words, then the re-submission waiting now.
  ids.earlier = (await system(() => app.prisma.verificationDocument.create({ data: {
    userId: ids.applicant, role: 'DRIVER', docType: 'vehicle_insurance', fileUrl: `${secrets.fileKey}.old`, status: 'REJECTED',
    reviewNote: secrets.earlierNote, reviewedAt: new Date(Date.now() - DAY), createdAt: new Date(Date.now() - 2 * DAY),
  } }))).id;
  ids.pending = (await system(() => app.prisma.verificationDocument.create({ data: {
    userId: ids.applicant, role: 'DRIVER', docType: 'vehicle_insurance', fileUrl: secrets.fileKey, status: 'PENDING',
    kycRef: secrets.kycRef, insurerName: secrets.insurer, policyNumber: secrets.policy, reviewNote: secrets.ownNote,
    consentAt: new Date(), privacyNoticeVersion: 'v-test', expiresAt: new Date(Date.now() + 200 * DAY),
    retentionExpiresAt: new Date(Date.now() + 400 * DAY),
  } }))).id;

  await adminWith('star', 'ADMIN', ['*']);
  await adminWith('superStar', 'SUPER_ADMIN', ['*']);
  await adminWith('reviewer', 'ADMIN', ['*', DOCUMENT_REVIEWER_CAPABILITY]);
  await adminWith('preset', 'ADMIN', [...DOC_REVIEWER_CAPABILITIES, DOCUMENT_REVIEWER_CAPABILITY]);
});

afterAll(async () => {
  await system(async () => {
    await purgeFixtureAuditTrail(app.prisma, userIds, 'verification-queue-minimal');
    await app.prisma.verificationDocument.deleteMany({ where: { userId: ids.applicant } });
    await app.prisma.driver.deleteMany({ where: { userId: ids.applicant } });
    await app.prisma.session.deleteMany({ where: { userId: { in: userIds } } });
    await app.prisma.admin.deleteMany({ where: { userId: { in: userIds } } });
    await app.prisma.user.deleteMany({ where: { id: { in: userIds } } });
  });
  await app.close();
});

describe('[DOC-SECURITY G3] the verification queue', () => {
  it('is registered as a sensitive read behind the document reviewer grant', () => {
    expect(ADMIN_ROUTE_AUTHORITY['GET /verification/queue']).toEqual({ cls: 'C1', capability: 'verification.read', requires: DOCUMENT_REVIEWER_CAPABILITY });
  });

  it('an ADMIN or SUPER_ADMIN holding `*` without the grant is refused, in plain words, and reads no one', async () => {
    for (const who of ['star', 'superStar']) {
      const res = await queue(tokens[who]!);
      expect(res.statusCode, `${who}: ${res.body.slice(0, 200)}`).toBe(403);
      expect(res.json().error.code).toBe('DOCUMENT_REVIEWER_REQUIRED');
      expect(res.body).not.toContain(`Queue${RUN}`);
      expect(res.body).not.toContain(applicantPhone.slice(-4));
    }
  });

  it('a reviewer gets only the fields the Review Center uses: no storage key, provider reference, policy, insurer or note', async () => {
    const res = await queue(tokens['reviewer']!);
    expect(res.statusCode, res.body.slice(0, 300)).toBe(200);
    const row = (res.json().data as Array<Record<string, unknown>>).find((d) => d['id'] === ids.pending);
    expect(row, 'the waiting document is listed').toBeDefined();
    expect(Object.keys(row!).sort()).toEqual(ROW_FIELDS);
    const user = row!['user'] as Record<string, unknown>;
    expect(Object.keys(user).sort()).toEqual(USER_FIELDS);
    expect(Object.keys(user['driver'] as object).sort()).toEqual(DRIVER_FIELDS);
    expect(user['driver']).toMatchObject({ licensePlate: `HC${RUN.slice(0, 4)}`, vehicleMake: 'Toyota' });
    // What the reviewer needs is still there: the earlier verdict and its words, the typed fields, consent.
    expect(row!['previousDecision']).toMatchObject({ documentId: ids.earlier, kind: 'RESUBMITTED_AFTER_REJECTION', reviewNote: secrets.earlierNote });
    expect(row!['reviewerTypes']).toEqual(expect.any(Array));
    expect(row!['privacyNoticeVersion']).toBe('v-test');
    // ...and nothing else, anywhere in the answer.
    for (const [name, value] of Object.entries({ fileKey: secrets.fileKey, kycRef: secrets.kycRef, insurer: secrets.insurer, policy: secrets.policy, ownNote: secrets.ownNote, legacy: secrets.legacyPointer })) {
      expect(res.body, name).not.toContain(value);
    }
    expect(res.body).not.toMatch(/"(fileUrl|kycRef|policyNumber|insurerName|subjectId|legalHoldId|retentionExpiresAt|state)"/);
  });

  it("the applicant's number is masked even for a grant that holds every contact capability (`*`)", async () => {
    const res = await queue(tokens['reviewer']!);
    expect(res.statusCode).toBe(200);
    const row = (res.json().data as Array<{ id: string; user: { phone: string } }>).find((d) => d.id === ids.pending)!;
    expect(row.user.phone).toMatch(new RegExp(`•+${applicantPhone.slice(-4)}$`));
    expect(res.body).not.toContain(applicantPhone);
    expect(res.body).not.toContain(applicantPhone.replace(/\D/g, ''));
  });

  it('the review console preset with the grant (no `*`) reads it too', async () => {
    const res = await queue(tokens['preset']!);
    expect(res.statusCode, res.body.slice(0, 300)).toBe(200);
    expect((res.json().data as Array<{ id: string }>).some((d) => d.id === ids.pending)).toBe(true);
  });

  it('every successful read leaves an access row naming the reader; a refused one leaves none', async () => {
    // A reader of its own, so no earlier test's row can land inside this count.
    const auditorId = await adminWith('auditor', 'ADMIN', ['*', DOCUMENT_REVIEWER_CAPABILITY]);
    const starId = (await system(() => app.prisma.session.findFirstOrThrow({ where: { token: tokens['star']! }, select: { userId: true } }))).userId;
    expect((await queue(tokens['auditor']!)).statusCode).toBe(200);
    const rows = await readRowsFor(auditorId, 1);
    expect(rows.length).toBe(1);
    expect(rows[0]).toMatchObject({ capability: 'verification.read', subjectId: null });
    expect((await queue(tokens['star']!)).statusCode).toBe(403);
    // A later recorded read is the clock: once it has landed, the refused read had its chance to write.
    expect((await queue(tokens['auditor']!)).statusCode).toBe(200);
    expect((await readRowsFor(auditorId, 2)).length).toBe(2);
    expect((await readRowsFor(starId, 0)).length).toBe(0);
  });
});
