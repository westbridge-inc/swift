import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import type { UserRole } from '@prisma/client';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { registerErrorHandler } from '../middleware/error-handler';
import { registerEmptyJsonBodyParser } from '../plugins/empty-json';
import { authRoutes } from '../modules/auth/auth.routes';
import { customerRoutes } from '../modules/user/customer.routes';
import { loginWithOtp } from './helpers/otp';

// ---------------------------------------------------------------------------
// [DELETION-INTEGRITY] A fresh OTP sign-in on THIS session is the step-up for
// account deletion and closure requests.
//
// Deletion and closure require proof that the caller holds the phone now. The
// app build under store review has no step-up sheet; its reviewer signs in
// with a code and presses Delete. A session that an OTP sign-in created in the
// last ten minutes carries exactly the proof a step-up gives, so those calls
// proceed. An older session, or one not created by OTP, still needs a step-up.
// ---------------------------------------------------------------------------

let app: FastifyInstance;
const userIds: string[] = [];
let seq = 0;
const phoneBase = 592_019_000_000 + Math.floor(Math.random() * 900_000);

async function signedIn(roles: UserRole[]) {
  seq += 1;
  const phone = `+${phoneBase + seq}`;
  const user = await app.prisma.user.create({ data: {
    phone, firstName: 'Fresh', lastName: `Otp${seq}`, email: `fresh${seq}-${nanoid(6)}@example.com`,
    roles, activeRole: roles[0]!, isPhoneVerified: true,
    ...(roles.includes('CUSTOMER') && { customer: { create: {} } }),
  } });
  userIds.push(user.id);
  if (roles.includes('VENDOR_OWNER')) await app.prisma.vendorOwner.create({ data: { userId: user.id } });
  const login = await loginWithOtp(app, phone);
  expect(login.statusCode, login.payload).toBe(200);
  return { userId: user.id, token: login.json().data.tokens.accessToken as string };
}

/** Build 9's exact call: DELETE /customer/account with its bearer token, no body. */
const build9Delete = (token: string) => app.inject({ method: 'DELETE', url: '/api/v1/customer/account', headers: { authorization: `Bearer ${token}` } });
const closureRequest = (token: string) => app.inject({ method: 'POST', url: '/api/v1/customer/account/closure-request', headers: { authorization: `Bearer ${token}` } });

beforeAll(async () => {
  const server = Fastify({ logger: false });
  registerErrorHandler(server);
  registerEmptyJsonBodyParser(server);
  await server.register(prismaPlugin);
  await server.register(redisPlugin);
  await server.register(authPlugin);
  await server.register(socketPlugin);
  await server.register(authRoutes, { prefix: '/api/v1/auth' });
  await server.register(customerRoutes, { prefix: '/api/v1/customer' });
  await server.ready();
  app = server;
});

afterAll(async () => {
  await app.prisma.notification.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.supportTicket.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.vendorOwner.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.session.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.customer.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await app.close();
});

describe('[DELETION-INTEGRITY] a fresh OTP sign-in counts as step-up for deletion', () => {
  it('build 9 deletes right after a code sign-in, with no step-up sheet', async () => {
    const p = await signedIn(['CUSTOMER']);
    const res = await build9Delete(p.token);
    expect(res.statusCode, res.payload).toBe(200);
    expect(res.json().data).toMatchObject({ deleted: true });
    expect(await app.prisma.user.findUniqueOrThrow({ where: { id: p.userId } })).toMatchObject({ phone: `deleted:${p.userId}`, status: 'DEACTIVATED' });
  });

  it('a business owner can request closure right after a code sign-in', async () => {
    const p = await signedIn(['VENDOR_OWNER', 'CUSTOMER']);
    const res = await closureRequest(p.token);
    expect(res.statusCode, res.payload).toBe(202);
    expect(res.json().data).toMatchObject({ status: 'CLOSURE_REQUESTED' });
  });

  it('a code sign-in older than ten minutes still needs a step-up, and nothing changes', async () => {
    const p = await signedIn(['CUSTOMER']);
    await app.prisma.session.updateMany({ where: { userId: p.userId }, data: { createdAt: new Date(Date.now() - 11 * 60_000) } });
    const res = await build9Delete(p.token);
    expect(res.statusCode, res.payload).toBe(403);
    expect(res.json().error.code).toBe('STEP_UP_REQUIRED');
    expect(await app.prisma.user.findUniqueOrThrow({ where: { id: p.userId } })).toMatchObject({ status: 'ACTIVE', firstName: 'Fresh' });
  });

  it('a fresh session that no code sign-in created still needs a step-up', async () => {
    const p = await signedIn(['CUSTOMER']);
    await app.prisma.session.updateMany({ where: { userId: p.userId }, data: { authMethod: 'LEGACY' } });
    const res = await build9Delete(p.token);
    expect(res.statusCode, res.payload).toBe(403);
    expect(res.json().error.code).toBe('STEP_UP_REQUIRED');
    expect(await app.prisma.user.findUniqueOrThrow({ where: { id: p.userId } })).toMatchObject({ status: 'ACTIVE' });
  });
});
