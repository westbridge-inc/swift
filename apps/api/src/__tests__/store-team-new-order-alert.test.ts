import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { io as ioClient, type Socket } from 'socket.io-client';
import { nanoid } from 'nanoid';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import ts from 'typescript';
import type { UserRole, UserStatus } from '@prisma/client';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { vendorRoutes } from '../modules/vendor/vendor.routes';
import { registerErrorHandler } from '../middleware/error-handler';
import { runWithoutTenant } from '../plugins/tenant-context';
import { NotificationService, escalateVendorAlert } from '../modules/notification/notification.service';
import { OrderService } from '../modules/order/order.service';
import { getChannels, devChannelLog } from '../providers/notifications/channels';

// ---------------------------------------------------------------------------
// [Owner ruling 13 Oct #15 · continues #1367 (loud alerts 2/4)] A store's new
// order rings its WHOLE active team while the store is open, not only the
// owner's phone (owner 15 Oct: "on duty" = owner, managers and staff of an
// OPEN store). Server-side only, so builds 9/10 hear it with the payloads
// they already route:
//  - every ACTIVE owner, MANAGER and STAFF of the store gets the new-order
//    inbox row, the loud ring_order push and the vendor:order_alert event;
//  - the team's phones join the store's live room (vendor:<id>), so order:new
//    reaches them at once, like the owner's;
//  - the "still waiting" re-alert rings the same team; the SMS fallback stays
//    on the owner's phone only;
//  - managers and staff ring only while STAFF_INVITE_ACCEPT is on (every
//    member then accepted an invite); while it is off only the owner rings
//    (coordinator ruling on review S3-1: consent);
//  - closing for the day keeps ringing the orders the store already has
//    (ruling on review S4-1); a store Swift has suspended rings nobody, while
//    its board still hears status changes;
//  - a member who is removed, or whose account is no longer ACTIVE, stops
//    hearing the store at once; a team row pointing at another tenant's
//    account carries nothing across the tenant wall.
//
// Fixture range: +5920471nnn (this file only).
// ---------------------------------------------------------------------------

const DAY = 24 * 60 * 60 * 1000;
const PHONE_PREFIX = '+5920471';
const priorInviteAccept = process.env['STAFF_INVITE_ACCEPT'];
const TENANT_B = `team-alert-b-${nanoid(6).toLowerCase()}`;

let app: FastifyInstance;
let url: string;
let notifications: NotificationService;
let orders: OrderService;
const sockets: Socket[] = [];

type Actor = { userId: string; phone: string; token: string; device: string };
let owner: Actor;
let manager: Actor;
let staff: Actor;
let suspendedStaff: Actor;
let foreignStaff: Actor;
let stranger: Actor;
let customer: Actor;
let vendorId: string;

let seq = 0;
async function makeUser(roles: UserRole[], activeRole: UserRole, opts: { tenantId?: string; status?: UserStatus } = {}): Promise<Actor> {
  seq += 1;
  const phone = `${PHONE_PREFIX}${String(seq).padStart(3, '0')}`;
  const user = await app.prisma.user.create({
    data: {
      phone, firstName: 'Team', lastName: `Alert${seq}`, roles, activeRole,
      isPhoneVerified: true, selfieCapturedAt: new Date(),
      ...(opts.tenantId ? { tenantId: opts.tenantId } : {}),
      ...(opts.status ? { status: opts.status } : {}),
      ...(roles.includes('CUSTOMER') && { customer: { create: {} } }),
    },
  });
  const token = app.jwt.sign({ userId: user.id, role: activeRole, jti: nanoid(8) });
  await app.prisma.session.create({
    data: {
      userId: user.id, token, refreshToken: nanoid(48),
      deviceId: `team-alert-${seq}`, deviceType: 'test', expiresAt: new Date(Date.now() + DAY),
    },
  });
  const device = `ExponentPushToken[tma${seq}${nanoid(10)}]`;
  await app.prisma.deviceToken.create({ data: { userId: user.id, token: device, platform: 'android' } });
  return { userId: user.id, phone, token, device };
}

async function makeStore(storeOwner: Actor, name: string): Promise<string> {
  const vendorOwner = await app.prisma.vendorOwner.create({ data: { userId: storeOwner.userId } });
  const vendor = await app.prisma.vendor.create({
    data: {
      ownerId: vendorOwner.id, name, slug: `team-alert-${nanoid(6).toLowerCase()}`,
      vendorType: 'RESTAURANT', phone: storeOwner.phone,
      addressLine1: '7 Team Street', city: 'Georgetown', region: 'Demerara-Mahaica',
      latitude: 6.81, longitude: -58.16,
      status: 'ACTIVE', acceptingOrders: true, isCurrentlyOpen: true, isVerified: true,
    },
  });
  return vendor.id;
}

async function addMember(member: Actor, role: 'MANAGER' | 'STAFF') {
  return app.prisma.vendorStaff.create({ data: { vendorId, userId: member.userId, role, invitedBy: owner.userId } });
}

async function setStore(state: { status?: 'ACTIVE' | 'SUSPENDED'; isCurrentlyOpen?: boolean }) {
  await app.prisma.vendor.update({ where: { id: vendorId }, data: state });
}

async function pendingOrder(holdMsFromNow?: number) {
  return app.prisma.order.create({
    data: {
      orderNumber: `TMA-${nanoid(8)}`,
      orderType: 'FOOD_DELIVERY',
      customerId: customer.userId,
      vendorId,
      status: 'PENDING',
      fulfillment: 'PICKUP',
      deliveryAddress: 'counter', deliveryLat: 6.81, deliveryLng: -58.16,
      pickupAddress: 'counter', pickupLat: 6.81, pickupLng: -58.16,
      subtotalBase: 1500, subtotalMarkup: 0, subtotalCustomer: 1500,
      deliveryFee: 0, totalAmount: 1500, paymentMethod: 'CASH',
      ...(holdMsFromNow !== undefined ? { holdExpiresAt: new Date(Date.now() + holdMsFromNow) } : {}),
      statusHistory: { create: { status: 'PENDING', changedBy: customer.userId, note: 'placed (test)' } },
    },
  });
}

const respondBy = () => new Date(Date.now() + 10 * 60_000);
const pushesTo = (a: Actor) => devChannelLog.filter((e) => e.channel === 'push' && e.to === a.device);
const smsTo = (a: Actor) => devChannelLog.filter((e) => e.channel === 'sms' && e.to === a.phone);
const alertRows = (orderId: string) => app.prisma.notification.findMany({
  where: { AND: [{ data: { path: ['kind'], equals: 'vendor_order_alert' } }, { data: { path: ['orderId'], equals: orderId } }] },
  orderBy: { createdAt: 'asc' },
});
const recipientsOf = async (orderId: string) => new Set((await alertRows(orderId)).map((r) => r.userId));

function call(method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, token: string, payload?: Record<string, unknown>) {
  return app.inject({
    method, url: path,
    ...(payload ? { payload } : {}),
    headers: { authorization: `Bearer ${token}`, ...(payload ? { 'content-type': 'application/json' } : {}) },
  });
}

function connect(token: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = ioClient(url, { auth: { token }, transports: ['websocket'], reconnection: false, timeout: 3000 });
    sockets.push(socket);
    const timer = setTimeout(() => reject(new Error('socket never became ready')), 7_500);
    socket.once('auth:ready', () => { clearTimeout(timer); resolve(socket); });
    socket.once('connect_error', (err) => { clearTimeout(timer); reject(err); });
  });
}

/** A signed-in phone with the store's board open: it asks for the store room
 *  exactly as the business app does, and records what the room delivers. */
async function boardOpen(actor: Actor, store = vendorId) {
  const socket = await connect(actor.token);
  const events: Array<{ event: string; payload: { orderId?: string } }> = [];
  for (const event of ['order:new', 'order:status_changed']) {
    socket.on(event, (payload: { orderId?: string }) => events.push({ event, payload }));
  }
  socket.emit('vendor:subscribe', { vendorId: store });
  return { socket, events, got: (event: string, orderId: string) => events.some((e) => e.event === event && e.payload?.orderId === orderId) };
}

const roomSocketIds = async (store = vendorId) => new Set((await app.io.in(`vendor:${store}`).fetchSockets()).map((s) => s.id));

async function purgeFixtures() {
  const users = await runWithoutTenant(() => app.prisma.user.findMany({ where: { phone: { startsWith: PHONE_PREFIX } }, select: { id: true } }), 'test-fixture:team-alert');
  const ids = users.map((u) => u.id);
  if (ids.length > 0) {
    await runWithoutTenant(async () => {
      const ownerIds = (await app.prisma.vendorOwner.findMany({ where: { userId: { in: ids } }, select: { id: true } })).map((o) => o.id);
      const vendorIds = (await app.prisma.vendor.findMany({ where: { ownerId: { in: ownerIds } }, select: { id: true } })).map((v) => v.id);
      const orderIds = (await app.prisma.order.findMany({ where: { OR: [{ customerId: { in: ids } }, { vendorId: { in: vendorIds } }] }, select: { id: true } })).map((o) => o.id);
      await app.prisma.alertDelivery.deleteMany({ where: { OR: [{ subjectId: { in: orderIds } }, { recipientId: { in: ids } }] } });
      await app.prisma.notification.deleteMany({ where: { userId: { in: ids } } });
      await app.prisma.deviceToken.deleteMany({ where: { userId: { in: ids } } });
      await app.prisma.order.deleteMany({ where: { id: { in: orderIds } } });
      await app.prisma.vendorStaff.deleteMany({ where: { OR: [{ userId: { in: ids } }, { vendorId: { in: vendorIds } }] } });
      await app.prisma.vendor.deleteMany({ where: { id: { in: vendorIds } } });
      await app.prisma.vendorOwner.deleteMany({ where: { id: { in: ownerIds } } });
      await app.prisma.session.deleteMany({ where: { userId: { in: ids } } });
      await app.prisma.customer.deleteMany({ where: { userId: { in: ids } } });
      await app.prisma.user.deleteMany({ where: { id: { in: ids } } });
    }, 'test-fixture:team-alert');
  }
  await runWithoutTenant(() => app.prisma.tenant.deleteMany({ where: { id: TENANT_B } }), 'test-fixture:team-alert');
}

beforeAll(async () => {
  process.env['NODE_ENV'] = 'test';
  // Team members are rung only once invites need acceptance (S3-1 ruling);
  // the consent case below turns it off on purpose.
  process.env['STAFF_INVITE_ACCEPT'] = '1';
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  await app.register(vendorRoutes, { prefix: '/api/v1/vendor' });
  await app.listen({ port: 0, host: '127.0.0.1' });
  url = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  notifications = new NotificationService(app.prisma, app.io);
  orders = new OrderService(app.prisma, app.io);
  await purgeFixtures();
  await runWithoutTenant(() => app.prisma.tenant.create({ data: { id: TENANT_B, name: 'Team alert tenant B', slug: TENANT_B, isActive: true } }), 'test-fixture:team-alert');

  owner = await makeUser(['VENDOR_OWNER'], 'VENDOR_OWNER');
  manager = await makeUser(['CUSTOMER'], 'CUSTOMER');
  staff = await makeUser(['CUSTOMER'], 'CUSTOMER');
  suspendedStaff = await makeUser(['CUSTOMER'], 'CUSTOMER', { status: 'SUSPENDED' });
  foreignStaff = await makeUser(['CUSTOMER'], 'CUSTOMER', { tenantId: TENANT_B });
  stranger = await makeUser(['VENDOR_OWNER'], 'VENDOR_OWNER');
  customer = await makeUser(['CUSTOMER'], 'CUSTOMER');
  vendorId = await makeStore(owner, 'Team Kitchen');
  await makeStore(stranger, 'Other Kitchen');
  await addMember(manager, 'MANAGER');
  await addMember(staff, 'STAFF');
  await addMember(suspendedStaff, 'STAFF');
  await addMember(foreignStaff, 'STAFF');
});

afterAll(async () => {
  if (priorInviteAccept === undefined) delete process.env['STAFF_INVITE_ACCEPT']; else process.env['STAFF_INVITE_ACCEPT'] = priorInviteAccept;
  for (const s of sockets) s.disconnect();
  await purgeFixtures();
  await app.close();
});

describe('[#15] an OPEN store rings its whole active team', () => {
  it('owner, manager and staff each get the same new-order row, the loud ring_order push and a delivery receipt; nobody else does', async () => {
    await setStore({ status: 'ACTIVE', isCurrentlyOpen: true });
    const order = await pendingOrder();
    const before = new Map([owner, manager, staff, suspendedStaff, foreignStaff, stranger].map((a) => [a.userId, pushesTo(a).length]));
    const deadline = respondBy();
    await notifications.newOrderForVendor(owner.userId, order.orderNumber, 1, 1500, order.id, deadline);

    expect(await recipientsOf(order.id)).toEqual(new Set([owner.userId, manager.userId, staff.userId]));
    const expected = {
      title: 'New Order!',
      data: { orderId: order.id, orderNumber: order.orderNumber, status: 'PENDING', kind: 'vendor_order_alert', respondBy: deadline.toISOString(), audience: 'business' },
      options: { alertClass: 'ring_order', priority: 'high', sound: 'default', deadlineMs: deadline.getTime() },
    };
    for (const member of [owner, manager, staff]) {
      const pushes = pushesTo(member).slice(before.get(member.userId));
      expect(pushes.map((p) => ({ title: p.title, data: p.data, options: p.options })), member.userId).toEqual([expected]);
    }
    for (const outsider of [suspendedStaff, foreignStaff, stranger]) {
      expect(pushesTo(outsider), `${outsider.userId} must not be rung`).toHaveLength(before.get(outsider.userId)!);
    }
    const receipts = await app.prisma.alertDelivery.findMany({ where: { kind: 'VENDOR_ORDER', subjectId: order.id } });
    expect(new Set(receipts.map((r) => r.recipientId))).toEqual(new Set([owner.userId, manager.userId, staff.userId]));
  });

  it('a released held order rings the team and reaches a manager and a staff phone with the board open at once (order:new)', async () => {
    await setStore({ status: 'ACTIVE', isCurrentlyOpen: true });
    const boards = await Promise.all([owner, manager, staff, stranger].map((a) => boardOpen(a)));
    await expect.poll(async () => (await roomSocketIds()).size, { timeout: 3000 }).toBe(3);
    const room = await roomSocketIds();
    expect(room.has(boards[3]!.socket.id!), 'another store owner never joins this room').toBe(false);

    const order = await pendingOrder(-1000);
    await orders.releaseDueHeldOrders(async () => {});
    for (const [i, member] of [owner, manager, staff].entries()) {
      await expect.poll(() => boards[i]!.got('order:new', order.id), { timeout: 3000, message: member.userId }).toBe(true);
    }
    expect(boards[3]!.got('order:new', order.id)).toBe(false);
    expect(await recipientsOf(order.id)).toEqual(new Set([owner.userId, manager.userId, staff.userId]));
    for (const b of boards) b.socket.disconnect();
  });

  it('the "still waiting" re-alert rings the team; the SMS fallback goes to the owner phone only', async () => {
    await setStore({ status: 'ACTIVE', isCurrentlyOpen: true });
    const order = await pendingOrder();
    await notifications.newOrderForVendor(owner.userId, order.orderNumber, 1, 1500, order.id, respondBy());
    const before = new Map([owner, manager, staff].map((a) => [a.userId, pushesTo(a).length]));
    expect(await escalateVendorAlert(app.prisma, app.io, getChannels(), order.id, 0)).toBe('realerted');
    for (const member of [owner, manager, staff]) {
      expect(pushesTo(member).slice(before.get(member.userId)).map((p) => p.title), member.userId).toEqual(['Order still waiting!']);
    }
    const texts = new Map([owner, manager, staff].map((a) => [a.userId, smsTo(a).length]));
    expect(await escalateVendorAlert(app.prisma, app.io, getChannels(), order.id, 1)).toBe('sms_sent');
    expect(smsTo(owner)).toHaveLength(texts.get(owner.userId)! + 1);
    expect(smsTo(manager)).toHaveLength(texts.get(manager.userId)!);
    expect(smsTo(staff)).toHaveLength(texts.get(staff.userId)!);
  });

  it('a staff member acknowledging the alert stops the ladder for the whole team', async () => {
    await setStore({ status: 'ACTIVE', isCurrentlyOpen: true });
    const order = await pendingOrder();
    await notifications.newOrderForVendor(owner.userId, order.orderNumber, 1, 1500, order.id, respondBy());
    const ack = await call('PUT', `/api/v1/vendor/orders/${order.id}/ack`, staff.token);
    expect(ack.statusCode, ack.body).toBe(200);
    const before = pushesTo(owner).length;
    expect(await escalateVendorAlert(app.prisma, app.io, getChannels(), order.id, 0)).toBe('stopped');
    expect(await escalateVendorAlert(app.prisma, app.io, getChannels(), order.id, 1)).toBe('stopped');
    expect(pushesTo(owner)).toHaveLength(before);
  });
});

describe('[#15 · S3-1 ruling] consent: managers and staff ring only once invites need acceptance', () => {
  it('with STAFF_INVITE_ACCEPT off only the owner is rung, first alert and re-alert; with it on an accepted member is', async () => {
    await setStore({ status: 'ACTIVE', isCurrentlyOpen: true });
    delete process.env['STAFF_INVITE_ACCEPT'];
    try {
      const order = await pendingOrder();
      const before = new Map([owner, manager, staff].map((a) => [a.userId, pushesTo(a).length]));
      await notifications.newOrderForVendor(owner.userId, order.orderNumber, 1, 1500, order.id, respondBy());
      expect(await recipientsOf(order.id)).toEqual(new Set([owner.userId]));
      expect(await escalateVendorAlert(app.prisma, app.io, getChannels(), order.id, 0)).toBe('realerted');
      expect(pushesTo(owner).slice(before.get(owner.userId)).map((p) => p.title)).toEqual(['New Order!', 'Order still waiting!']);
      for (const member of [manager, staff]) expect(pushesTo(member), member.userId).toHaveLength(before.get(member.userId)!);
    } finally {
      process.env['STAFF_INVITE_ACCEPT'] = '1';
    }
    const order = await pendingOrder();
    const before = pushesTo(staff).length;
    await notifications.newOrderForVendor(owner.userId, order.orderNumber, 1, 1500, order.id, respondBy());
    expect(pushesTo(staff).slice(before).map((p) => p.title)).toEqual(['New Order!']);
  });
});

describe('[#15 · S4-1 ruling] closing for the day keeps ringing the orders the store already has', () => {
  it('a store closed after an order was placed: the team is still rung and re-alerted, the owner texted, the board told', async () => {
    await setStore({ status: 'ACTIVE', isCurrentlyOpen: true });
    const board = await boardOpen(owner);
    await expect.poll(async () => (await roomSocketIds()).has(board.socket.id!), { timeout: 3000 }).toBe(true);
    const order = await pendingOrder(-1000);
    await setStore({ status: 'ACTIVE', isCurrentlyOpen: false });
    const texts = smsTo(owner).length;
    await orders.releaseDueHeldOrders(async () => {});
    expect(await recipientsOf(order.id)).toEqual(new Set([owner.userId, manager.userId, staff.userId]));
    await expect.poll(() => board.got('order:new', order.id), { timeout: 3000 }).toBe(true);
    expect(await escalateVendorAlert(app.prisma, app.io, getChannels(), order.id, 0)).toBe('realerted');
    expect(await escalateVendorAlert(app.prisma, app.io, getChannels(), order.id, 1)).toBe('sms_sent');
    expect(smsTo(owner)).toHaveLength(texts + 1);
    board.socket.disconnect();
    await setStore({ status: 'ACTIVE', isCurrentlyOpen: true });
  });
});

describe('[#15] a store Swift has suspended rings nobody', () => {
  it('no row, no push, no re-alert, no SMS and no order:new, for the owner either', async () => {
    await setStore({ status: 'ACTIVE', isCurrentlyOpen: true });
    const board = await boardOpen(owner);
    await expect.poll(async () => (await roomSocketIds()).has(board.socket.id!), { timeout: 3000 }).toBe(true);
    const order = await pendingOrder(-1000);
    await setStore({ status: 'SUSPENDED', isCurrentlyOpen: true });
    const pushes = new Map([owner, manager, staff].map((a) => [a.userId, pushesTo(a).length]));
    const texts = smsTo(owner).length;
    await orders.releaseDueHeldOrders(async () => {});
    await notifications.newOrderForVendor(owner.userId, order.orderNumber, 1, 1500, order.id, respondBy());
    expect(await alertRows(order.id)).toEqual([]);
    expect(await escalateVendorAlert(app.prisma, app.io, getChannels(), order.id, 0)).toBe('stopped');
    expect(await escalateVendorAlert(app.prisma, app.io, getChannels(), order.id, 1)).toBe('stopped');
    for (const member of [owner, manager, staff]) expect(pushesTo(member), member.userId).toHaveLength(pushes.get(member.userId)!);
    expect(smsTo(owner)).toHaveLength(texts);
    await new Promise((r) => setTimeout(r, 200));
    expect(board.got('order:new', order.id), 'no order:new takeover for a suspended store').toBe(false);
    board.socket.disconnect();
    await setStore({ status: 'ACTIVE', isCurrentlyOpen: true });
  });

  it('[review S3-2 · P7] its board still hears a status change on an order it already has', async () => {
    await setStore({ status: 'ACTIVE', isCurrentlyOpen: true });
    const board = await boardOpen(owner);
    await expect.poll(async () => (await roomSocketIds()).has(board.socket.id!), { timeout: 3000 }).toBe(true);
    const order = await pendingOrder();
    await setStore({ status: 'SUSPENDED', isCurrentlyOpen: false });
    // A real board change: the store accepts the order (OrderService.updateStatus
    // publishes order:status_changed to the store room through the gate).
    await orders.updateStatus(order.id, 'ACCEPTED', owner.userId, 'accepted (test)');
    await expect.poll(() => board.got('order:status_changed', order.id), { timeout: 3000 }).toBe(true);
    board.socket.disconnect();
    await setStore({ status: 'ACTIVE', isCurrentlyOpen: true });
  });
});

describe('[#15] who stops hearing the store, at once', () => {
  it('a removed member leaves the room the moment the owner removes them and is never rung again', async () => {
    await setStore({ status: 'ACTIVE', isCurrentlyOpen: true });
    const temp = await makeUser(['CUSTOMER'], 'CUSTOMER');
    const row = await addMember(temp, 'STAFF');
    const board = await boardOpen(temp);
    await expect.poll(async () => (await roomSocketIds()).has(board.socket.id!), { timeout: 3000 }).toBe(true);

    const removed = await call('DELETE', `/api/v1/vendor/staff/${row.id}`, owner.token);
    expect(removed.statusCode, removed.body).toBe(200);
    // Evicted by the removal itself, before any further event is published.
    await expect.poll(async () => (await roomSocketIds()).has(board.socket.id!), { timeout: 1000 }).toBe(false);

    const before = pushesTo(temp).length;
    const order = await pendingOrder(-1000);
    await orders.releaseDueHeldOrders(async () => {});
    await new Promise((r) => setTimeout(r, 200));
    expect(board.got('order:new', order.id)).toBe(false);
    expect(pushesTo(temp)).toHaveLength(before);
    expect(await recipientsOf(order.id)).toEqual(new Set([owner.userId, manager.userId, staff.userId]));
    board.socket.disconnect();
  });

  it('a member whose account stops being ACTIVE hears nothing more from the room, even with a socket still joined', async () => {
    await setStore({ status: 'ACTIVE', isCurrentlyOpen: true });
    const temp = await makeUser(['CUSTOMER'], 'CUSTOMER');
    await addMember(temp, 'STAFF');
    const board = await boardOpen(temp);
    await expect.poll(async () => (await roomSocketIds()).has(board.socket.id!), { timeout: 3000 }).toBe(true);
    // Suspended directly in the database: no socket is disconnected for it.
    await app.prisma.user.update({ where: { id: temp.userId }, data: { status: 'SUSPENDED' } });

    const order = await pendingOrder(-1000);
    await orders.releaseDueHeldOrders(async () => {});
    await new Promise((r) => setTimeout(r, 200));
    expect(board.got('order:new', order.id)).toBe(false);
    expect((await roomSocketIds()).has(board.socket.id!), 'the gate evicts a socket it refused').toBe(false);
    board.socket.disconnect();
  });

  it('[review S3-2 · P6] the re-alert never reaches a member removed or suspended after the first alert', async () => {
    await setStore({ status: 'ACTIVE', isCurrentlyOpen: true });
    const leaving = await makeUser(['CUSTOMER'], 'CUSTOMER');
    const suspending = await makeUser(['CUSTOMER'], 'CUSTOMER');
    const row = await addMember(leaving, 'STAFF');
    await addMember(suspending, 'STAFF');
    const order = await pendingOrder();
    await notifications.newOrderForVendor(owner.userId, order.orderNumber, 1, 1500, order.id, respondBy());
    expect((await recipientsOf(order.id)).has(leaving.userId) && (await recipientsOf(order.id)).has(suspending.userId)).toBe(true);

    const removed = await call('DELETE', `/api/v1/vendor/staff/${row.id}`, owner.token);
    expect(removed.statusCode, removed.body).toBe(200);
    await app.prisma.user.update({ where: { id: suspending.userId }, data: { status: 'SUSPENDED' } });
    const before = new Map([owner, leaving, suspending].map((a) => [a.userId, pushesTo(a).length]));
    expect(await escalateVendorAlert(app.prisma, app.io, getChannels(), order.id, 0)).toBe('realerted');
    expect(pushesTo(owner).slice(before.get(owner.userId)).map((p) => p.title)).toEqual(['Order still waiting!']);
    expect(pushesTo(leaving), 'removed member').toHaveLength(before.get(leaving.userId)!);
    expect(pushesTo(suspending), 'suspended member').toHaveLength(before.get(suspending.userId)!);
  });

  it('another tenant account on the team row, a suspended member and another store owner are refused the room', async () => {
    await setStore({ status: 'ACTIVE', isCurrentlyOpen: true });
    const refused = await Promise.all([foreignStaff, suspendedStaff, stranger].map((a) => connect(a.token).then((socket) => {
      socket.emit('vendor:subscribe', { vendorId });
      return socket;
    }).catch(() => null)));
    const control = await boardOpen(manager);
    await expect.poll(async () => (await roomSocketIds()).has(control.socket.id!), { timeout: 3000 }).toBe(true);
    await new Promise((r) => setTimeout(r, 200));
    const room = await roomSocketIds();
    for (const s of refused) if (s?.id) expect(room.has(s.id)).toBe(false);
    for (const s of refused) s?.disconnect();
    control.socket.disconnect();
  });
});

/** True when `arg` is a store-room literal (vendor:...), an array holding one,
 *  or an identifier whose declaration in the same file initializes it to one
 *  (mirrors the order-room census). */
function namesStoreRoom(arg: ts.Expression, ast: ts.SourceFile): boolean {
  if (/^[`'"]vendor:/.test(arg.getText(ast))) return true;
  if (ts.isArrayLiteralExpression(arg)) return arg.elements.some((el) => namesStoreRoom(el, ast));
  if (!ts.isIdentifier(arg)) return false;
  let found = false;
  const visit = (n: ts.Node) => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === arg.text
      && n.initializer && namesStoreRoom(n.initializer, ast)) found = true;
    if (!found) ts.forEachChild(n, visit);
  };
  visit(ast);
  return found;
}

describe('[#15] every publication to a store room goes through the team gate', () => {
  it('no direct to()/in()/except() on a vendor: room remains; the gate has every publisher', () => {
    const sources = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      if (entry.name === '__tests__') return [];
      const path = join(dir, entry.name);
      return entry.isDirectory() ? sources(path) : path.endsWith('.ts') ? [path] : [];
    });
    const bypasses: string[] = [];
    let publishers = 0;
    for (const file of sources(join(__dirname, '..'))) {
      const text = readFileSync(file, 'utf8');
      const ast = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
      const visit = (n: ts.Node) => {
        if (ts.isCallExpression(n)) {
          if (n.expression.getText(ast) === 'emitToStoreRoom') publishers++;
          // [review S4-4] Written inline, in an array, or held in a variable first.
          if (ts.isPropertyAccessExpression(n.expression) && ['to', 'in', 'except'].includes(n.expression.name.text)
            && n.arguments.some((arg) => namesStoreRoom(arg, ast))) {
            bypasses.push(file + ':' + (ast.getLineAndCharacterOfPosition(n.getStart(ast)).line + 1));
          }
        }
        ts.forEachChild(n, visit);
      };
      visit(ast);
    }
    expect(bypasses).toEqual([]);
    // 12 + the admin store-refund close (#1607).
    expect(publishers).toBe(13);
  });
});

