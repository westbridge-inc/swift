import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { Prisma, type UserRole } from '@prisma/client';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { registerErrorHandler } from '../middleware/error-handler';
import { registerEmptyJsonBodyParser } from '../plugins/empty-json';
import { adminRoutes } from '../modules/admin/admin.routes';
import { ADMIN_ACTION_CLASSES, ADMIN_ROUTE_AUTHORITY } from '../modules/admin/admin-authority';
import { testPhone } from './helpers/fixture-ids';
import { TEST_ADMIN_REASON } from './helpers/admin-reason';

// The public deletion page tells someone who cannot sign in to email us, and staff had no way to act on that: the only
// staff path needs a request confirmed inside a signed-in session. A verified request can now be completed from the
// person's page: SUPER_ADMIN only, with a reason and how identity was checked, through the same deleteAccount, every
// blocker honoured, and through the same two-person rule (the owner's solo approval while the owner is the only admin).

const RUN = nanoid(6).replace(/[^a-zA-Z0-9]/g, 'x');
const ROUTE = 'POST /users/:id/verified-deletion';
const GOOD = { identityCheck: 'CODE_TO_ACCOUNT_NUMBER', identityNote: 'Code texted to the account number came back on the email thread' };

let app: FastifyInstance;
const userIds: string[] = [];
const orderIds: string[] = [];
const vendorIds: string[] = [];

async function person(roles: UserRole[] = ['CUSTOMER']) {
  const user = await app.prisma.user.create({ data: {
    phone: testPhone(), firstName: 'Verified', lastName: `D${RUN}${userIds.length}`, email: `verified-${nanoid(6)}@example.com`, roles, activeRole: roles[0]!, isPhoneVerified: true,
  } });
  userIds.push(user.id);
  return user.id;
}

async function staff(role: 'ADMIN' | 'SUPER_ADMIN') {
  const user = await app.prisma.user.create({ data: {
    phone: testPhone(), firstName: 'Staff', lastName: `S${RUN}${userIds.length}`, roles: [role, 'CUSTOMER'], activeRole: role, status: 'ACTIVE', isPhoneVerified: true, admin: { create: { permissions: ['*'] } },
  } });
  userIds.push(user.id);
  const token = app.jwt.sign({ userId: user.id, role, jti: nanoid(8) });
  await app.prisma.session.create({ data: { userId: user.id, token, refreshToken: nanoid(48), authMethod: 'OTP', deviceId: `vd-${nanoid(4)}`, deviceType: 'test', expiresAt: new Date(Date.now() + 86_400_000) } });
  return { id: user.id, token };
}

const call = (token: string, method: string, url: string, payload?: Record<string, unknown>, headers: Record<string, string> = {}) => app.inject({
  method: method as never, url: `/api/v1/admin${url}`,
  headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...headers },
  ...(payload ? { payload } : {}),
});

const ask = (token: string, id: string, body: Record<string, unknown> = GOOD) => call(token, 'POST', `/users/${id}/verified-deletion`, { reason: TEST_ADMIN_REASON, ...body });

/** Ask as one super admin, approve as another, and execute as the one who asked. */
async function askApproveApply(subjectId: string, body: Record<string, unknown> = GOOD, by = requester) {
  const asked = await ask(by.token, subjectId, body);
  expect(asked.statusCode, asked.payload).toBe(202);
  const approvalId = asked.json().error.details.approvalId as string;
  const decided = await call(approver.token, 'POST', `/approvals/${approvalId}/decide`, { approve: true, reason: TEST_ADMIN_REASON });
  expect(decided.statusCode, decided.payload).toBe(200);
  return { approvalId, applied: await call(by.token, 'POST', `/approvals/${approvalId}/apply`) };
}

const pendingFor = (userId: string) => app.prisma.privilegedApproval.count({ where: { requestedBy: userId } });
const auditRows = (entityId: string) => app.prisma.auditLog.findMany({ where: { entityId, changes: { path: ['identityCheck'], not: Prisma.AnyNull } } });

let requester: { id: string; token: string };
let approver: { id: string; token: string };
let plainAdmin: { id: string; token: string };

beforeAll(async () => {
  process.env['NODE_ENV'] = 'development';
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  registerEmptyJsonBodyParser(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  await app.register(adminRoutes, { prefix: '/api/v1/admin' });
  await app.ready();
  requester = await staff('SUPER_ADMIN');
  approver = await staff('SUPER_ADMIN');
  plainAdmin = await staff('ADMIN');
});

afterAll(async () => {
  await app.prisma.order.deleteMany({ where: { id: { in: orderIds } } });
  await app.prisma.vendor.deleteMany({ where: { id: { in: vendorIds } } });
  await app.prisma.vendorOwner.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.session.deleteMany({ where: { userId: { in: userIds } } });
  await app.close();
});

describe('the door', () => {
  it('is a platform act: a reason and two people, on a capability of its own', () => {
    expect(ADMIN_ROUTE_AUTHORITY[ROUTE]).toMatchObject({ cls: 'C5', capability: 'user.close.verified' });
    expect(ADMIN_ACTION_CLASSES.C5).toMatchObject({ requiresReason: true, requiresApproval: true });
  });

  it('is SUPER_ADMIN only: an admin is refused before anything is queued', async () => {
    const subject = await person();
    const res = await ask(plainAdmin.token, subject);
    expect(res.statusCode).toBe(403);
    expect(await pendingFor(plainAdmin.id)).toBe(0);
  });

  it('a person with no staff role is refused', async () => {
    const subject = await person();
    const outsider = await person();
    const token = app.jwt.sign({ userId: outsider, role: 'CUSTOMER', jti: nanoid(8) });
    await app.prisma.session.create({ data: { userId: outsider, token, refreshToken: nanoid(48), authMethod: 'OTP', deviceId: `vd-${nanoid(4)}`, deviceType: 'test', expiresAt: new Date(Date.now() + 86_400_000) } });
    expect((await ask(token, subject)).statusCode).toBe(403);
  });

  it('no reason, nothing queued', async () => {
    const subject = await person();
    const before = await pendingFor(requester.id);
    const res = await call(requester.token, 'POST', `/users/${subject}/verified-deletion`, GOOD);
    expect(res.statusCode).toBe(400);
    expect(await pendingFor(requester.id)).toBe(before);
  });

  it('the person page says whether the viewer is a founder, so the console offers the door only then', async () => {
    const subject = await person();
    const read = async (token: string) => (await call(token, 'GET', `/users/${subject}`)).json().data.viewer;
    expect(await read(requester.token)).toEqual({ superAdmin: true });
    expect(await read(plainAdmin.token)).toEqual({ superAdmin: false });
  });

  it('asking deletes nothing: it waits in the approvals queue', async () => {
    const subject = await person();
    const res = await ask(requester.token, subject);
    expect(res.statusCode, res.payload).toBe(202);
    expect(res.json().error.code).toBe('APPROVAL_REQUIRED');
    expect(await app.prisma.user.findUniqueOrThrow({ where: { id: subject } })).toMatchObject({ status: 'ACTIVE' });
    expect(await auditRows(subject)).toEqual([]);
  });
});

describe('once approved', () => {
  it('runs the same erasure as the person\'s own deletion, and records who, why and how identity was checked', async () => {
    const subject = await person();
    const { approvalId, applied } = await askApproveApply(subject);
    expect(applied.statusCode, applied.payload).toBe(200);

    expect(await app.prisma.user.findUniqueOrThrow({ where: { id: subject } })).toMatchObject({ status: 'DEACTIVATED', phone: `deleted:${subject}`, firstName: 'Deleted', email: null });
    const [row, ...rest] = await auditRows(subject);
    expect(rest).toEqual([]);
    expect(row).toMatchObject({ userId: requester.id, entityId: subject });
    expect(row!.changes).toMatchObject({ reason: TEST_ADMIN_REASON, identityCheck: GOOD.identityCheck, identityNote: GOOD.identityNote, approvalId });
  });

  it('every blocker holds: an open order refuses it, the account stays, and no deletion is recorded', async () => {
    const owner = await person(['VENDOR_OWNER', 'CUSTOMER']);
    const vendorOwner = await app.prisma.vendorOwner.create({ data: { userId: owner } });
    const vendor = await app.prisma.vendor.create({ data: {
      ownerId: vendorOwner.id, name: 'Synthetic store', slug: `vd-${nanoid(12)}`, vendorType: 'RESTAURANT', phone: 'synthetic', addressLine1: 'Synthetic', city: 'Synthetic', region: 'Synthetic',
      latitude: 0, longitude: 0, status: 'ACTIVE', acceptingOrders: true, isCurrentlyOpen: true,
    } });
    vendorIds.push(vendor.id);
    const customer = await person();
    const order = await app.prisma.order.create({ data: {
      orderNumber: `VD-${nanoid(10).toUpperCase()}`, customerId: customer, vendorId: vendor.id, orderType: 'FOOD_DELIVERY', status: 'PREPARING', deliveryAddress: '1 Test St', deliveryLat: 6.8055, deliveryLng: -58.1553,
      subtotalBase: 1500, subtotalMarkup: 0, subtotalCustomer: 1500, deliveryFee: 0, totalAmount: 1500, paymentMethod: 'CASH',
    } });
    orderIds.push(order.id);

    const { applied } = await askApproveApply(owner);
    expect(applied.statusCode, applied.payload).toBe(409);
    expect(await app.prisma.user.findUniqueOrThrow({ where: { id: owner } })).toMatchObject({ status: 'ACTIVE' });
    expect(await auditRows(owner)).toEqual([]);
  });

  it('a staff account is never closed here', async () => {
    const other = await staff('ADMIN');
    const { applied } = await askApproveApply(other.id);
    expect(applied.statusCode, applied.payload).toBe(403);
    expect(await app.prisma.user.findUniqueOrThrow({ where: { id: other.id } })).toMatchObject({ status: 'ACTIVE' });
  });

  it('an account already closed says so', async () => {
    const subject = await person();
    await askApproveApply(subject);
    const again = await askApproveApply(subject);
    expect(again.applied.statusCode, again.applied.payload).toBe(409);
    expect(await auditRows(subject)).toHaveLength(1);
  });

  it.each([
    ['a number long enough to be an ID or a phone', { identityCheck: 'CODE_TO_ACCOUNT_NUMBER', identityNote: 'Passport 123456 matched the name on file' }],
    ['a phone number written with spaces', { identityCheck: 'OWNER_CHECKED', identityNote: 'Owner called them on 600 1234 and they agreed' }],
    ['an email address', { identityCheck: 'OWNER_CHECKED', identityNote: 'Owner replied to someone@example.com about it' }],
    ['a note too short to say anything', { identityCheck: 'OWNER_CHECKED', identityNote: 'yes' }],
    ['a method that is not on the list', { identityCheck: 'PHOTO_OF_ID', identityNote: 'Checked the photo the person sent in' }],
    ['the identity document itself', { ...GOOD, identityDocument: 'uploads/id.jpg' }],
  ])('refuses %s and deletes nothing', async (_what, body) => {
    const subject = await person();
    const { applied } = await askApproveApply(subject, body);
    expect(applied.statusCode, applied.payload).toBe(400);
    expect(await app.prisma.user.findUniqueOrThrow({ where: { id: subject } })).toMatchObject({ status: 'ACTIVE' });
    expect(await auditRows(subject)).toEqual([]);
  });

  it('takes the owner\'s own check as a recorded method', async () => {
    const subject = await person();
    const { applied } = await askApproveApply(subject, { identityCheck: 'OWNER_CHECKED', identityNote: 'Owner spoke to the person and is satisfied it is them' });
    expect(applied.statusCode, applied.payload).toBe(200);
    expect((await auditRows(subject))[0]!.changes).toMatchObject({ identityCheck: 'OWNER_CHECKED' });
  });
});
