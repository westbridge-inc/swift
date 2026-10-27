// ---------------------------------------------------------------------------
// [AUTH-FIX PR2 · journeys roster] The journey provisioner approves a fresh store's documents through
// the admin console's approve route (scripts/livetest/provision.ts approveDoc). On a fresh database it
// could not: the route insists on what a reviewer TYPES (a registration's kind, a certificate's year,
// the own-name check), the provisioner sent none of it, so no store activated and every store journey
// failed. Here the provisioner's own request body is sent to the real route for every typed document a
// store or its owner presents, and each one is approved.
// ---------------------------------------------------------------------------
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { prismaPlugin, runWithoutTenant } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { registerErrorHandler } from '../middleware/error-handler';
import { registerEmptyJsonBodyParser } from '../plugins/empty-json';
import { adminRoutes } from '../modules/admin/admin.routes';

const RUN = nanoid(8).replace(/[^a-zA-Z0-9]/g, '0');
const NUM = String(Date.now()).slice(-5);
const DAY = 86_400_000;
const REASON = `Journey provisioner review ${RUN}: checked against the document`;

let app: FastifyInstance;
let approvalBody: (docId: string, docType: string, vehicleType?: string) => Record<string, unknown>;
let adminToken = '';
const users: string[] = [];
let seq = 0;
const system = <T>(fn: () => Promise<T>) => runWithoutTenant(fn, 'livetest-store-approve-test');

type Role = 'MOVER' | 'VENDOR_OWNER' | 'CUSTOMER';
async function subject(role: Role = 'MOVER') {
  seq += 1;
  const u = await system(() => app.prisma.user.create({ data: {
    phone: `+59279${NUM}${String(seq).padStart(2, '0')}`, firstName: `Ls${RUN}`, lastName: `S${seq}`,
    roles: [role] as never[], activeRole: role as never, status: 'ACTIVE', isPhoneVerified: true, countryCode: 'GY',
    ...(role === 'CUSTOMER' ? { trustLevel: 'L1' as const } : {}),
  } }));
  users.push(u.id);
  return u.id;
}
async function pending(userId: string, docType: string, role: Role = 'MOVER') {
  return system(() => app.prisma.verificationDocument.create({ data: {
    userId, role, docType, fileUrl: '', status: 'PENDING', consentAt: new Date(), privacyNoticeVersion: 'v1',
  } }));
}
const approve = (docId: string, payload: Record<string, unknown>) => app.inject({
  method: 'PUT', url: `/api/v1/admin/verification/${docId}/approve`, payload,
  headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json', 'x-swift-reason': REASON },
});
const statusOf = async (id: string) =>
  (await system(() => app.prisma.verificationDocument.findUniqueOrThrow({ where: { id } }))).status;

beforeAll(async () => {
  ({ approvalBody } = await import(pathToFileURL(join(__dirname, '../../../../scripts/livetest/provision.ts')).href));
  process.env['NODE_ENV'] = 'test';
  app = Fastify({ logger: false });
  registerErrorHandler(app); registerEmptyJsonBodyParser(app);
  await app.register(prismaPlugin); await app.register(redisPlugin); await app.register(authPlugin); await app.register(socketPlugin);
  await app.register(adminRoutes, { prefix: '/api/v1/admin' });
  await app.ready();
  const a = await system(() => app.prisma.user.create({ data: {
    phone: `+59279${NUM}99`, firstName: 'Ls', lastName: `Admin${RUN}`, roles: ['SUPER_ADMIN', 'CUSTOMER'], activeRole: 'SUPER_ADMIN',
    status: 'ACTIVE', isPhoneVerified: true,
    // `documents.review`: the explicit document reviewer grant (PR-V3); harmless where it is not yet demanded.
    admin: { create: { permissions: ['*', 'documents.review'] } },
  } }));
  users.push(a.id);
  adminToken = app.jwt.sign({ userId: a.id, role: 'SUPER_ADMIN', jti: nanoid(8) });
  await system(() => app.prisma.session.create({ data: {
    userId: a.id, token: adminToken, refreshToken: nanoid(48), authMethod: 'OTP', deviceId: `ls-${RUN}`, deviceType: 'test', expiresAt: new Date(Date.now() + DAY),
  } }));
});

afterAll(async () => {
  await system(async () => {
    const docs = await app.prisma.verificationDocument.findMany({ where: { userId: { in: users } }, select: { id: true } });
    await app.prisma.reviewDecision.deleteMany({ where: { case: { submissionId: { in: docs.map((d) => d.id) } } } }).catch(() => {});
    await app.prisma.reviewCase.deleteMany({ where: { submissionId: { in: docs.map((d) => d.id) } } }).catch(() => {});
    await app.prisma.documentRecord.deleteMany({ where: { submissionId: { in: docs.map((d) => d.id) } } }).catch(() => {});
    await app.prisma.verificationDocument.deleteMany({ where: { userId: { in: users } } }).catch(() => {});
    await app.prisma.identityKey.deleteMany({ where: { accountId: { in: users } } }).catch(() => {});
    await app.prisma.identityClusterMember.deleteMany({ where: { accountId: { in: users } } }).catch(() => {});
    await app.prisma.notification.deleteMany({ where: { userId: { in: users } } }).catch(() => {});
    await app.prisma.session.deleteMany({ where: { userId: { in: users } } });
    await app.prisma.admin.deleteMany({ where: { userId: { in: users } } });
    await app.prisma.customer.deleteMany({ where: { userId: { in: users } } }).catch(() => {});
    await app.prisma.user.deleteMany({ where: { id: { in: users } } }).catch(() => {});
  });
  await app.close();
});

// Every document a store or its owner presents that the reviewer must type something for.
const STORE_TYPED = [
  'business_registration', 'own_name_declaration', 'gra_restaurant_licence', 'sanitary_certificate', 'trade_licence',
  'food_handler_cert', 'eating_house_registration', 'owner_national_id', 'police_clearance',
];

describe('[journeys roster] the provisioner approves a fresh store\'s typed documents', () => {
  for (const docType of STORE_TYPED) {
    it(`${docType}: the provisioner's approval body is accepted and the document is APPROVED`, async () => {
      const doc = await pending(await subject('VENDOR_OWNER'), docType, 'VENDOR_OWNER');
      const res = await approve(doc.id, approvalBody(doc.id, docType));
      expect(res.statusCode, res.body).toBe(200);
      expect(await statusOf(doc.id)).toBe('APPROVED');
    });
  }
});
