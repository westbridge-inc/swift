import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
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
import { AccountService, ACCOUNT_CLOSURE_CONFIRMED } from '../modules/user/account.service';
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
const advertiserIds: string[] = [];
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
/** Build 10+: the same call, declaring that it shows every receipt by its own message. */
const build10Delete = (token: string) => app.inject({ method: 'DELETE', url: '/api/v1/customer/account?receipts=v2', headers: { authorization: `Bearer ${token}` } });
const profile = (token: string) => app.inject({ method: 'GET', url: '/api/v1/customer/profile', headers: { authorization: `Bearer ${token}` } });
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
  await app.prisma.advertiser.deleteMany({ where: { id: { in: advertiserIds } } });
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
    // Build 9 shows this message and has no code sheet on this screen: it must
    // name the step build 9 can take, never promise a code it will not ask for.
    expect(res.json().error.message).toMatch(/sign back in with a code.*within 10 minutes/);
    expect(await app.prisma.user.findUniqueOrThrow({ where: { id: p.userId } })).toMatchObject({ status: 'ACTIVE', firstName: 'Fresh' });
    // Build 10+ opens its code sheet on this refusal.
    const modern = await build10Delete(p.token);
    expect(modern.statusCode, modern.payload).toBe(403);
    expect(modern.json().error).toMatchObject({ code: 'STEP_UP_REQUIRED', details: { stepUp: { send: 'POST /auth/step-up' } } });
    expect(modern.json().error.message).toMatch(/^Confirm it/);
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

describe('[DELETION-INTEGRITY] build 9 never shows a false deletion receipt', () => {
  // Build 9 (frozen in store review) says "Your account has been deleted." and
  // signs out on every success except PENDING_DOCUMENT_ERASURE, where it shows
  // the server's message. It must never say deleted while the account is open.
  afterEach(() => { vi.restoreAllMocks(); });

  it('a business owner who taps Delete on build 9 is told the truth and stays signed in', async () => {
    const p = await signedIn(['VENDOR_OWNER', 'CUSTOMER']);
    const res = await build9Delete(p.token);
    expect(res.statusCode, res.payload).toBe(409);
    expect(res.json().error).toMatchObject({ code: 'ACCOUNT_CLOSURE_REQUESTED', details: { status: 'CLOSURE_REQUESTED' } });
    expect(res.json().error.message).toMatch(/closure request is received/);
    expect(await app.prisma.user.findUniqueOrThrow({ where: { id: p.userId } })).toMatchObject({ status: 'ACTIVE', firstName: 'Fresh' });
    expect(await app.prisma.session.count({ where: { userId: p.userId } })).toBe(1);
    // The request itself is not lost: one confirmed closure ticket exists.
    const tickets = await app.prisma.supportTicket.findMany({ where: { userId: p.userId } });
    expect(tickets).toHaveLength(1);
    expect(res.json().error.details.ticketId).toBe(tickets[0]!.id);
    expect(await app.prisma.auditLog.count({ where: { action: ACCOUNT_CLOSURE_CONFIRMED, entityId: tickets[0]!.id } })).toBe(1);

    const modern = await build10Delete(p.token);
    expect(modern.statusCode, modern.payload).toBe(202);
    expect(modern.json().data).toMatchObject({ deleted: false, status: 'CLOSURE_REQUESTED', ticketId: tickets[0]!.id });
  });

  it('a closed account whose erasure is still pending is reported in build 9 words that are true', async () => {
    const real = AccountService.prototype.deleteAccount;
    const cleanupFails = async function (this: AccountService, userId: string, selfServe?: boolean) {
      await real.call(this, userId, selfServe);
      throw new Error('synthetic cleanup failure after the deletion marker committed');
    };
    for (const [call, status] of [[build9Delete, 'PENDING_DOCUMENT_ERASURE'], [build10Delete, 'PENDING_ACCOUNT_ERASURE']] as const) {
      const p = await signedIn(['CUSTOMER']);
      vi.spyOn(AccountService.prototype, 'deleteAccount').mockImplementationOnce(cleanupFails);
      const res = await call(p.token);
      expect(res.statusCode, res.payload).toBe(202);
      expect(res.json().data).toMatchObject({ deleted: false, status });
      expect(res.json().data.message).toMatch(/^Your account is closed\. .*retried automatically/);
      expect(await app.prisma.user.findUniqueOrThrow({ where: { id: p.userId } })).toMatchObject({ phone: `deleted:${p.userId}`, status: 'DEACTIVATED' });
    }
  });

  it('a legal hold receipt reaches build 9 with its own message, never as a completed deletion', async () => {
    const held = {
      deleted: false as const, status: 'PENDING_LEGAL_HOLD' as const, heldDocuments: 1, heldMoverObjects: 0, pendingDocuments: 0, pendingAvatarObjects: 0,
      message: 'Your account is closed. Documents required by a legal hold remain protected until the hold is released; other pending erasure will be retried automatically.',
    };
    for (const [call, status] of [[build9Delete, 'PENDING_DOCUMENT_ERASURE'], [build10Delete, 'PENDING_LEGAL_HOLD']] as const) {
      const p = await signedIn(['CUSTOMER']);
      vi.spyOn(AccountService.prototype, 'deleteAccount').mockResolvedValueOnce(held);
      const res = await call(p.token);
      expect(res.statusCode, res.payload).toBe(202);
      expect(res.json().data).toMatchObject({ deleted: false, status, message: held.message });
    }
  });

  it('the profile says which flow Delete starts, from the same rule the server applies', async () => {
    const customer = await signedIn(['CUSTOMER']);
    const owner = await signedIn(['VENDOR_OWNER', 'CUSTOMER']);
    const member = await signedIn(['CUSTOMER']);
    const adv = await app.prisma.advertiser.create({ data: {
      companyName: `Closure Ads ${nanoid(5)}`, industry: 'Retail', contactName: 'Synthetic', contactEmail: 'synthetic@example.com',
      contactPhone: 'synthetic', createdByUserId: member.userId, members: { create: { userId: member.userId, role: 'ANALYST' } },
    } });
    advertiserIds.push(adv.id);
    for (const [p, flow] of [[customer, 'DELETE'], [owner, 'REQUEST'], [member, 'REQUEST']] as const) {
      const res = await profile(p.token);
      expect(res.statusCode, res.payload).toBe(200);
      expect(res.json().data.accountClosure).toBe(flow);
    }
    // The advertiser member's Delete really is a closure request.
    const res = await build10Delete(member.token);
    expect(res.statusCode, res.payload).toBe(202);
    expect(res.json().data).toMatchObject({ status: 'CLOSURE_REQUESTED' });
  });
});
