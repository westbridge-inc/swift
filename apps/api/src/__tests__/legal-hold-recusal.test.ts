/**
 * [SEC-PII · money/trust scan 28 Oct 2026] A LEGAL HOLD IS PLACED AND RELEASED BY SOMEONE ELSE.
 *
 * Every document decision (claim, approve, reject, escalate, fraud confirmation) refuses a reviewer who is the
 * subject or in the subject's identity cluster (DOC-1 §8.6, recusal.ts). The document legal hold did not: an
 * admin could release the hold on their own account's (or a linked account's) held evidence, which makes it
 * erasable again (self-service erasure, the retention reaper). Releasing and placing a hold now apply the same
 * recusal, inside the hold's own transaction; nothing changes when the hold is refused.
 */
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
import { purgeAuditLogs } from '../lib/audit-immutability';
import { placeDocLegalHold, releaseDocLegalHold } from '../modules/verification/legal-hold';
import { TEST_ADMIN_REASON } from './helpers/admin-reason';
import { testPhone } from './helpers/fixture-ids';

const RUN = nanoid(8).replace(/[^a-zA-Z0-9]/g, '0');
const DAY = 86_400_000;
const system = <T>(fn: () => Promise<T>) => runWithoutTenant(fn, 'legal-hold-recusal-test');
let app: FastifyInstance;
const users: string[] = [];
const tokens = new Map<string, string>();
let clusterId = '';
const ids = { subject: '', linked: '', other: '', subjectAdmin: '' };

async function account(roles: string[], adminGrant: boolean) {
  const u = await system(() => app.prisma.user.create({ data: {
    phone: testPhone(), firstName: 'Hold', lastName: `R${RUN}`, roles: roles as never, activeRole: roles[0] as never, status: 'ACTIVE', isPhoneVerified: true,
    ...(adminGrant ? { admin: { create: { permissions: ['*'] } } } : {}),
  } as never }));
  users.push(u.id);
  if (adminGrant) {
    const token = app.jwt.sign({ userId: u.id, role: 'ADMIN', jti: nanoid(8) });
    await system(() => app.prisma.session.create({ data: { userId: u.id, token, refreshToken: nanoid(48), authMethod: 'OTP', deviceId: `lhr-${RUN}-${users.length}`, deviceType: 'test', expiresAt: new Date(Date.now() + DAY) } }));
    tokens.set(u.id, token);
  }
  return u.id;
}
const doc = (userId: string) => system(() => app.prisma.verificationDocument.create({ data: {
  userId, role: 'MOVER', docType: 'drivers_licence', fileUrl: '', status: 'REJECTED', state: 'REJECTED',
} as never }));
const hold = (subjectUserId: string, by: string) => system(() => placeDocLegalHold(app.prisma, {
  subjectUserId, reason: `Fraud evidence kept ${RUN}`, ownerId: by, placedBy: by, reviewBy: new Date(Date.now() + 30 * DAY),
}));
const release = (adminId: string, holdId: string) => app.inject({
  method: 'PUT', url: `/api/v1/admin/verification/legal-holds/${holdId}/release`, payload: { reason: TEST_ADMIN_REASON },
  headers: { authorization: `Bearer ${tokens.get(adminId)}`, 'content-type': 'application/json', 'x-swift-reason': TEST_ADMIN_REASON },
});
const place = (adminId: string, subjectUserId: string) => app.inject({
  method: 'POST', url: '/api/v1/admin/verification/legal-holds',
  payload: { subjectUserId, reason: TEST_ADMIN_REASON, reviewBy: new Date(Date.now() + 30 * DAY).toISOString() },
  headers: { authorization: `Bearer ${tokens.get(adminId)}`, 'content-type': 'application/json', 'x-swift-reason': TEST_ADMIN_REASON },
});
const holdRow = (id: string) => system(() => app.prisma.docLegalHold.findUniqueOrThrow({ where: { id } }));

beforeAll(async () => {
  app = Fastify({ logger: false });
  registerErrorHandler(app); registerEmptyJsonBodyParser(app);
  await app.register(prismaPlugin); await app.register(redisPlugin); await app.register(authPlugin); await app.register(socketPlugin);
  await app.register(adminRoutes, { prefix: '/api/v1/admin' });
  await app.ready();
  // The subject is itself an admin (the insider case); a second admin shares its identity cluster; a third is unrelated.
  ids.subject = await account(['ADMIN', 'RIDER'], true);
  ids.linked = await account(['ADMIN', 'CUSTOMER'], true);
  ids.other = await account(['ADMIN', 'CUSTOMER'], true);
  const cluster = await system(() => app.prisma.identityCluster.create({ data: {
    members: { create: [ids.subject, ids.linked].map((accountId) => ({ accountId, linkedVia: [{ type: 'DEVICE', strength: 1, matchedAccountId: ids.subject, at: new Date().toISOString() }] })) },
  } }));
  clusterId = cluster.id;
});

afterAll(async () => {
  await system(async () => {
    await purgeAuditLogs(app.prisma, { userId: { in: users } }, 'test-cleanup:legal-hold-recusal').catch(() => 0);
    if (clusterId) { await app.prisma.identityClusterMember.deleteMany({ where: { clusterId } }); await app.prisma.identityCluster.deleteMany({ where: { id: clusterId } }); }
    await app.prisma.verificationDocument.deleteMany({ where: { userId: { in: users } } });
    await app.prisma.docLegalHold.deleteMany({ where: { subjectUserId: { in: users } } });
    await app.prisma.identityKey.deleteMany({ where: { accountId: { in: users } } });
    await app.prisma.session.deleteMany({ where: { userId: { in: users } } });
    await app.prisma.admin.deleteMany({ where: { userId: { in: users } } });
    await app.prisma.user.deleteMany({ where: { id: { in: users } } });
  });
  await app.close();
});

describe('[SEC-PII] legal hold release and placement are recused like every document decision', () => {
  it('the subject cannot release the hold on their own documents; the hold and its documents stay held', async () => {
    const d = await doc(ids.subject);
    const { hold: h } = await hold(ids.subject, ids.other);
    const res = await release(ids.subject, h.id);
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('REVIEWER_RECUSED');
    expect((await holdRow(h.id)).releasedAt).toBeNull();
    expect((await system(() => app.prisma.verificationDocument.findUniqueOrThrow({ where: { id: d.id } }))).legalHoldId).toBe(h.id);
    // the service itself refuses too (any caller, not only the route)
    await expect(system(() => releaseDocLegalHold(app.prisma, { holdId: h.id, releasedBy: ids.subject, reason: 'self' }))).rejects.toMatchObject({ code: 'REVIEWER_RECUSED' });
  });

  it('an admin in the subject\'s identity cluster cannot release it either', async () => {
    const { hold: h } = await system(() => app.prisma.docLegalHold.findFirstOrThrow({ where: { subjectUserId: ids.subject, releasedAt: null } })).then((row) => ({ hold: row }));
    const res = await release(ids.linked, h.id);
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('REVIEWER_RECUSED');
    expect((await holdRow(h.id)).releasedAt).toBeNull();
  });

  it('an unrelated admin releases it as before', async () => {
    const h = await system(() => app.prisma.docLegalHold.findFirstOrThrow({ where: { subjectUserId: ids.subject, releasedAt: null } }));
    const res = await release(ids.other, h.id);
    expect(res.statusCode, res.payload).toBe(200);
    expect((await holdRow(h.id)).releasedBy).toBe(ids.other);
  });

  it('placing: the subject or a linked admin is refused (nothing is held); an unrelated admin places it', async () => {
    await doc(ids.subject);
    for (const adminId of [ids.subject, ids.linked]) {
      const res = await place(adminId, ids.subject);
      expect(res.statusCode, adminId).toBe(403);
      expect(res.json().error.code).toBe('REVIEWER_RECUSED');
    }
    expect(await system(() => app.prisma.docLegalHold.count({ where: { subjectUserId: ids.subject, releasedAt: null } }))).toBe(0);
    const ok = await place(ids.other, ids.subject);
    expect(ok.statusCode, ok.payload).toBe(201);
  });

  it('an identity record awaiting review never stops a hold being placed (it preserves evidence); a release then waits for the review', async () => {
    const flagged = await account(['RIDER', 'CUSTOMER'], false);
    await doc(flagged);
    const cluster = await system(() => app.prisma.identityCluster.create({ data: {
      authorityReviewRequired: true, members: { create: [{ accountId: flagged, linkedVia: [] }] },
    } }));
    try {
      const placed = await place(ids.other, flagged);
      expect(placed.statusCode, placed.payload).toBe(201);
      const holdId = placed.json().data.hold.id as string;
      const res = await release(ids.other, holdId);
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe('IDENTITY_REVIEW_REQUIRED');
      expect((await holdRow(holdId)).releasedAt).toBeNull();
    } finally {
      await system(async () => { await app.prisma.identityClusterMember.deleteMany({ where: { clusterId: cluster.id } }); await app.prisma.identityCluster.deleteMany({ where: { id: cluster.id } }); });
    }
  });
});
