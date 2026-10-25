import Fastify, { type FastifyInstance } from 'fastify';
import multipart from '@fastify/multipart';
import { customAlphabet, nanoid } from 'nanoid';
import { Prisma, type UserRole } from '@prisma/client';
import { expect, vi } from 'vitest';
import { beginRequestTenantContext, prismaPlugin, runWithoutTenant } from '../../plugins/prisma';
import { redisPlugin } from '../../plugins/redis';
import { authPlugin } from '../../plugins/auth';
import { socketPlugin } from '../../plugins/socket';
import { registerTenantHeaderScope } from '../../plugins/tenant-header-scope';
import { registerEmptyJsonBodyParser } from '../../plugins/empty-json';
import { registerErrorHandler } from '../../middleware/error-handler';
import { customerRoutes } from '../../modules/user/customer.routes';
import { vendorRoutes } from '../../modules/vendor/vendor.routes';
import { authRoutes } from '../../modules/auth/auth.routes';
import { purgeAuditLogs, purgeSensitiveReadLogs } from '../../lib/audit-immutability';

// GOLD-7 shares the GOLD-2/6 composition and fixture helpers, not product
// substitutes. Each file owns a distinct, range-audited phone prefix. Every
// defining action goes through a mounted production route, on real Postgres.
// Every golden file must assert notifications only for users it owns: deleting
// our own users inherently cascades their inbox, including peer-created rows.
export type Actor = { userId: string; token: string; refreshToken: string; sessionId: string; phone: string };
export const DAY = 86_400_000;

export function createGolden(phonePrefix: string, fixture: string) {
  const fixturePrefix = `${fixture}-${nanoid(16)}`;
  let app: FastifyInstance;
  let seq = 0;
  const phoneRun = customAlphabet('0123456789', 5)();
  const nextPhone = () => `${phonePrefix}${phoneRun}${String(++seq).padStart(3, '0')}`;
  const createdIds = new Set<string>();
  const savedClusterIds = new Set<string>();
  const createdAlertIds = new Set<string>();
  const createdNotificationIds = new Set<string>();
  let restoreNotificationTracking: (() => void) | undefined;
  let restoreAlertTracking: (() => void) | undefined;
  const sys = <T>(fn: () => Promise<T>) => runWithoutTenant(fn, fixture);

  async function rememberClusters(userId: string) {
    const members = await sys(() => app.prisma.identityClusterMember.findMany({ where: { accountId: userId }, select: { clusterId: true } }));
    for (const member of members) savedClusterIds.add(member.clusterId);
  }

  function call(method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, token: string, payload?: unknown, headers: Record<string, string> = {}) {
    return app.inject({ method, url, headers: {
      ...headers, authorization: `Bearer ${token}`,
      ...(payload !== undefined ? { 'content-type': 'application/json' } : {}),
    }, ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}) });
  }

  async function actor(roles: UserRole[] = ['CUSTOMER'], activeRole: UserRole = roles[0]!) {
    const phone = nextPhone();
    const user = await sys(() => app.prisma.user.create({ data: {
      id: `${fixturePrefix}-${nanoid(12)}`, phone, firstName: 'Golden', lastName: fixture, roles, activeRole,
      isPhoneVerified: true, selfieCapturedAt: new Date(), trustLevel: 'L2', countryCode: 'GY',
      ...(roles.includes('CUSTOMER') && { customer: { create: {} } }),
      ...(roles.includes('ADMIN') && { admin: { create: { permissions: ['*'] } } }),
    } }));
    createdIds.add(user.id); // erasure changes the phone; retain the fixture id
    const token = app.jwt.sign({ userId: user.id, role: activeRole, jti: nanoid(8) });
    const refreshToken = nanoid(48);
    const session = await sys(() => app.prisma.session.create({ data: {
      userId: user.id, token, refreshToken, authMethod: 'OTP', deviceId: `${fixturePrefix}-${seq}`,
      deviceType: 'test', expiresAt: new Date(Date.now() + DAY),
    } }));
    if (roles.includes('CUSTOMER')) await sys(() => app.prisma.address.create({ data: {
      userId: user.id, label: 'Home', addressLine1: '7 Golden Lane', city: 'Georgetown',
      region: 'Demerara-Mahaica', latitude: 6.8045, longitude: -58.1553, isDefault: true,
    } }));
    return { userId: user.id, token, refreshToken, sessionId: session.id, phone };
  }

  async function vendor(owner: Actor) {
    const row = await sys(() => app.prisma.vendorOwner.create({ data: { userId: owner.userId } }));
    const store = await sys(() => app.prisma.vendor.create({ data: {
      ownerId: row.id, name: 'Golden Counter', slug: `${fixturePrefix}-${nanoid(8)}`.toLowerCase(),
      vendorType: 'RESTAURANT', phone: owner.phone, addressLine1: '7 Golden Road', city: 'Georgetown',
      region: 'Demerara-Mahaica', latitude: 6.8013, longitude: -58.1551, status: 'ACTIVE',
      acceptingOrders: true, isCurrentlyOpen: true, isVerified: true, deliveryRadius: 50,
    } }));
    const category = await sys(() => app.prisma.category.create({ data: { vendorId: store.id, name: 'Mains' } }));
    const item = await sys(() => app.prisma.item.create({ data: {
      vendorId: store.id, categoryId: category.id, name: 'Golden Meal', basePrice: 1200, isAvailable: true,
    } }));
    return { vendorId: store.id, categoryId: category.id, itemId: item.id };
  }

  async function purge() {
    await sys(async () => {
      // Every alert kind can target another run's fixture. Ownership comes only
      // from successful inserts, even if none of our users survive erasure.
      await app.prisma.alertDelivery.deleteMany({ where: { id: { in: [...createdAlertIds] } } });
      await app.prisma.notification.deleteMany({ where: { id: { in: [...createdNotificationIds] } } });
      const users = await app.prisma.user.findMany({ where: { OR: [
        { id: { in: [...createdIds] } },
        { id: { startsWith: `${fixturePrefix}-` } },
      ] }, select: { id: true } });
      const ids = users.map((u) => u.id);
      if (!ids.length) return;
      const vendorIds = (await app.prisma.vendor.findMany({ where: { owner: { userId: { in: ids } } }, select: { id: true } })).map((v) => v.id);
      const riderIds = (await app.prisma.rider.findMany({ where: { userId: { in: ids } }, select: { id: true } })).map((r) => r.id);
      const sessionIds = (await app.prisma.session.findMany({ where: { userId: { in: ids } }, select: { id: true } })).map((r) => r.id);
      const docs = (await app.prisma.verificationDocument.findMany({ where: { userId: { in: ids } }, select: { id: true } })).map((d) => d.id);
      const cases = (await app.prisma.reviewCase.findMany({ where: { submissionId: { in: docs } }, select: { id: true } })).map((c) => c.id);
      await purgeAuditLogs(app.prisma, { OR: [{ userId: { in: ids } }, { entityId: { in: [...ids, ...docs, ...cases, ...vendorIds] } }] }, `test-cleanup:${fixture}`);
      await purgeSensitiveReadLogs(app.prisma, { OR: [{ actorUserId: { in: ids } }, { subjectId: { in: docs } }] }, `test-cleanup:${fixture}`);
      await app.prisma.reviewDecision.deleteMany({ where: { caseId: { in: cases } } });
      await app.prisma.reviewCase.deleteMany({ where: { id: { in: cases } } });
      await app.prisma.verificationDocument.deleteMany({ where: { id: { in: docs } } });
      await app.prisma.encryptedObject.deleteMany({ where: { createdBy: { in: ids } } });
      await app.prisma.storageOrphan.deleteMany({ where: { userId: { in: ids } } });
      await app.prisma.identityKey.deleteMany({ where: { accountId: { in: ids } } });
      await app.prisma.trialGrant.deleteMany({ where: { accountId: { in: ids } } });
      const members = await app.prisma.identityClusterMember.findMany({ where: { accountId: { in: ids } }, select: { clusterId: true } });
      await app.prisma.identityClusterMember.deleteMany({ where: { accountId: { in: ids } } });
      for (const clusterId of new Set([...savedClusterIds, ...members.map((m) => m.clusterId)])) {
        if (await app.prisma.identityClusterMember.count({ where: { clusterId } }) === 0) {
          await app.prisma.identityCluster.deleteMany({ where: { id: clusterId, mergedIntoId: null } });
        }
      }
      const subIds = (await app.prisma.subscription.findMany({ where: { vendorId: { in: vendorIds } }, select: { id: true } })).map((s) => s.id);
      await app.prisma.feeReceipt.deleteMany({ where: { subscriptionId: { in: subIds } } });
      await app.prisma.subscriptionPayment.deleteMany({ where: { subscriptionId: { in: subIds } } });
      await app.prisma.prepaidBalance.deleteMany({ where: { subscriptionId: { in: subIds } } });
      await app.prisma.billingEvent.deleteMany({ where: { subscriptionId: { in: subIds } } });
      await app.prisma.subscription.deleteMany({ where: { id: { in: subIds } } });
      const orderIds = (await app.prisma.order.findMany({ where: { OR: [
        { customerId: { in: ids } }, { vendorId: { in: vendorIds } },
      ] }, select: { id: true } })).map((o) => o.id);
      const ratings = (await app.prisma.rating.findMany({ where: { orderId: { in: orderIds } }, select: { id: true } })).map((r) => r.id);
      await app.prisma.ratingReport.deleteMany({ where: { ratingId: { in: ratings } } });
      await app.prisma.ratingOutbox.deleteMany({ where: { ratingId: { in: ratings } } });
      await app.prisma.rating.deleteMany({ where: { id: { in: ratings } } });
      await app.prisma.actorRatingStat.deleteMany({ where: { subjectId: { in: [...ids, ...vendorIds] } } });
      await app.prisma.algoDecision.deleteMany({ where: { subjectId: { in: [...orderIds, ...vendorIds, ...riderIds] } } });
      await app.prisma.dispatchSearch.deleteMany({ where: { subjectId: { in: orderIds } } });
      // Stock movements, consent and deletion receipts are append-only evidence.
      // Their scalar subject IDs allow the mutable fixtures to be removed.
      await app.prisma.orderOutbox.deleteMany({ where: { orderId: { in: orderIds } } });
      await app.prisma.checkoutReceipt.deleteMany({ where: { userId: { in: ids } } });
      await app.prisma.earning.deleteMany({ where: { orderId: { in: orderIds } } });
      await app.prisma.order.deleteMany({ where: { id: { in: orderIds } } });
      await app.prisma.cart.deleteMany({ where: { customerId: { in: ids } } });
      await app.prisma.address.deleteMany({ where: { userId: { in: ids } } });
      await app.prisma.rider.deleteMany({ where: { id: { in: riderIds } } });
      await app.prisma.item.deleteMany({ where: { vendorId: { in: vendorIds } } });
      await app.prisma.category.deleteMany({ where: { vendorId: { in: vendorIds } } });
      await app.prisma.vendor.deleteMany({ where: { id: { in: vendorIds } } });
      await app.prisma.vendorOwner.deleteMany({ where: { userId: { in: ids } } });
      await app.prisma.session.deleteMany({ where: { userId: { in: ids } } });
      await app.prisma.admin.deleteMany({ where: { userId: { in: ids } } });
      await app.prisma.customer.deleteMany({ where: { userId: { in: ids } } });
      await app.prisma.user.deleteMany({ where: { id: { in: ids } } });
      const wanted = new Set([...ids, ...vendorIds, ...orderIds, ...riderIds, ...sessionIds]);
      let cursor = '0';
      do {
        const [next, keys] = await app.redis.scan(cursor, 'COUNT', 1000);
        cursor = next;
        const mine = keys.filter((k) => k.split(':').some((part) => wanted.has(part)));
        if (mine.length) await app.redis.del(...mine);
      } while (cursor !== '0');
    });
  }

  async function start(extra?: (instance: FastifyInstance) => Promise<void>) {
    app = Fastify({ logger: false });
    registerErrorHandler(app);
    registerEmptyJsonBodyParser(app);
    await app.register(multipart, { limits: { fileSize: 5 * 1024 * 1024, files: 1 } });
    await app.register(prismaPlugin);
    await app.register(redisPlugin);
    await app.register(authPlugin);
    await app.register(socketPlugin);
    app.addHook('onRequest', async () => { beginRequestTenantContext(); });
    registerTenantHeaderScope(app);
    await app.register(customerRoutes, { prefix: '/api/v1/customer' });
    await app.register(vendorRoutes, { prefix: '/api/v1/vendor' });
    await app.register(authRoutes, { prefix: '/api/v1/auth' });
    if (extra) await extra(app);
    await app.ready();
    // [G7-01] Track both production write paths, for every alert kind. A single
    // create owns its ID only after success (including calls that select no ID).
    // Bulk RETURNING captures only rows actually inserted, so skipDuplicates
    // cannot claim a peer's keyed alert, even if it wins a concurrent insert.
    const alerts = app.prisma.alertDelivery;
    const create = alerts.create.bind(alerts);
    const createManyAndReturn = alerts.createManyAndReturn.bind(alerts);
    const singleTracking = vi.spyOn(alerts, 'create').mockImplementation((async (args: Prisma.AlertDeliveryCreateArgs) => {
      const id = args.data.id ?? `${fixturePrefix}-alert-${nanoid(16)}`;
      const result = await create({ ...args, data: { ...args.data, id } });
      createdAlertIds.add(id);
      return result;
    }) as unknown as typeof create);
    const bulkTracking = vi.spyOn(alerts, 'createMany').mockImplementation((async (args: Prisma.AlertDeliveryCreateManyArgs) => {
      const inserted = await createManyAndReturn({ ...args, select: { id: true } });
      for (const row of inserted) createdAlertIds.add(row.id);
      return { count: inserted.length };
    }) as unknown as typeof alerts.createMany);
    restoreAlertTracking = () => { singleTracking.mockRestore(); bulkTracking.mockRestore(); };
    const notifications = app.prisma.notification;
    const createNotification = notifications.create.bind(notifications);
    const createNotifications = notifications.createManyAndReturn.bind(notifications);
    const singleNotificationTracking = vi.spyOn(notifications, 'create').mockImplementation((async (args: Prisma.NotificationCreateArgs) => {
      const id = args.data.id ?? `${fixturePrefix}-notification-${nanoid(16)}`;
      const result = await createNotification({ ...args, data: { ...args.data, id } });
      createdNotificationIds.add(id);
      return result;
    }) as unknown as typeof createNotification);
    const bulkNotificationTracking = vi.spyOn(notifications, 'createMany').mockImplementation((async (args: Prisma.NotificationCreateManyArgs) => {
      const inserted = await createNotifications({ ...args, select: { id: true } });
      for (const row of inserted) createdNotificationIds.add(row.id);
      return { count: inserted.length };
    }) as unknown as typeof notifications.createMany);
    restoreNotificationTracking = () => { singleNotificationTracking.mockRestore(); bulkNotificationTracking.mockRestore(); };
    await purge();
  }

  async function fillCart(customer: Actor, store: { vendorId: string; itemId: string }, quantity = 1) {
    const added = await call('POST', '/api/v1/customer/cart/items', customer.token, { ...store, quantity });
    expect(added.statusCode, added.json().error?.code).toBe(201);
  }

  return { get app() { return app; }, sys, call, actor, vendor, start, purge, fillCart, rememberClusters, nextPhone,
    close: async () => {
      try {
        // Admin audit writes may finish just after the response (GOLD-5).
        await new Promise((resolve) => setTimeout(resolve, 300));
        await purge();
      } finally { restoreAlertTracking?.(); restoreNotificationTracking?.(); await app.close(); }
    },
  };
}
