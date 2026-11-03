import { beforeAll, afterAll, it, expect } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { registerErrorHandler } from '../middleware/error-handler';
import { adminRoutes } from '../modules/admin/admin.routes';
import { nanoid } from 'nanoid';
import { testPhone } from './helpers/fixture-ids';
let app: FastifyInstance;
let token: string;
const users: string[] = [];
beforeAll(async () => {
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  await app.register(adminRoutes, { prefix: '/api/v1/admin' });
  await app.ready();
  // [DOC-SECURITY G3] The queue is a document reviewer's read: an admin holding the grant reads it.
  const reviewer = await app.prisma.user.create({ data: {
    phone: testPhone(), firstName: 'Synthetic', lastName: 'Reviewer', roles: ['ADMIN', 'CUSTOMER'], activeRole: 'ADMIN', status: 'ACTIVE', isPhoneVerified: true,
    admin: { create: { permissions: ['*', 'documents.review'] } },
  } });
  users.push(reviewer.id);
  token = app.jwt.sign({ userId: reviewer.id, role: 'ADMIN', jti: nanoid(8) });
  await app.prisma.session.create({ data: { userId: reviewer.id, token, refreshToken: nanoid(48), authMethod: 'OTP', deviceId: 'previous-decision', deviceType: 'test', expiresAt: new Date(Date.now() + 86_400_000) } });
});
afterAll(async () => {
  await app.prisma.verificationDocument.deleteMany({ where: { userId: { in: users } } });
  await app.prisma.session.deleteMany({ where: { userId: { in: users } } });
  await app.prisma.admin.deleteMany({ where: { userId: { in: users } } });
  await app.prisma.user.deleteMany({ where: { id: { in: users } } });
  await app.close();
});
it('the real queue carries the earlier matching decision, never another lane or applicant', async () => {
  const user = await app.prisma.user.create({ data: { phone: testPhone(), firstName: 'Synthetic', lastName: 'Applicant', roles: ['CUSTOMER'], activeRole: 'CUSTOMER' } });
  users.push(user.id);
  const old = await app.prisma.verificationDocument.create({ data: { userId: user.id, role: 'CUSTOMER', docType: 'national_id', status: 'REJECTED', fileUrl: 'test/previous', reviewNote: 'The image was unreadable.', createdAt: new Date(Date.now() - 20_000), reviewedAt: new Date(Date.now() - 19_000) } });
  await app.prisma.verificationDocument.create({ data: { userId: user.id, role: 'MOVER', docType: 'national_id', status: 'REJECTED', fileUrl: 'test/other-lane', reviewNote: 'Different lane.', createdAt: new Date(Date.now() - 10_000) } });
  const current = await app.prisma.verificationDocument.create({ data: { userId: user.id, role: 'CUSTOMER', docType: 'national_id', status: 'PENDING', fileUrl: 'test/current' } });
  const res = await app.inject({ method: 'GET', url: '/api/v1/admin/verification/queue?status=PENDING&role=customer&limit=100', headers: { authorization: `Bearer ${token}` } });
  expect(res.statusCode).toBe(200);
  const row = res.json().data.find((doc: { id: string }) => doc.id === current.id);
  expect(row.previousDecision).toMatchObject({ documentId: old.id, kind: 'RESUBMITTED_AFTER_REJECTION', status: 'REJECTED', reviewNote: 'The image was unreadable.' });
  expect(row.previousDecision).not.toHaveProperty('fileUrl');
});
