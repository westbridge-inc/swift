import { Prisma, PrismaClient } from '@prisma/client';
import { nanoid } from 'nanoid';
import { expect, it, vi } from 'vitest';
import { NotificationService } from '../../modules/notification/notification.service';
import { PartnerService } from '../../modules/partner/partner.service';
import { createGolden } from './gold-7-helpers';

// [G7-01] Cleanup isolation, not a journey. A concurrent writer can use the
// same admin subject and recipient. Before/after census is not ownership.
// Phone +5920978…: run-random suffix plus sequence; no shared literal phone.
it('removes only exact run-inserted alerts of every kind and preserves peer fan-out and mover offers', async () => {
  const other = new PrismaClient();
  const h = createGolden('+5920978', 'gold7-cleanup');
  const peerRun = createGolden('+5920978', 'gold7-cleanup');
  const recipientId = `gold7-external-${nanoid(12)}`;
  const beforeId = `gold7-before-${nanoid(12)}`;
  const peerOfferId = `gold7-peer-offer-${nanoid(12)}`;
  const duringId = `gold7-during-${nanoid(12)}`;
  const peerId = `gold7-cleanup-${nanoid(16)}-${nanoid(12)}`;
  const peerAlertIds: string[] = [];
  const peerNotificationIds: string[] = [];
  const ownedNotificationIds: string[] = [];
  const ownedAlertIds = [0, 1].map(() => `gold7-owned-${nanoid(16)}`);
  const data = { kind: 'ADMIN_OPS', subjectId: 'vendor_pending', recipientId };
  // Separate client = another run. Capture that writer's exact insert IDs for
  // its own final cleanup; neither a recipient nor a before/after census owns it.
  const createMany = other.alertDelivery.createMany.bind(other.alertDelivery);
  const peerTracking = vi.spyOn(other.alertDelivery, 'createMany').mockImplementation((async (args: Prisma.AlertDeliveryCreateManyArgs) => {
    const rows = (Array.isArray(args.data) ? args.data : [args.data]).map((row) => ({ ...row, id: `${peerId}-alert-${nanoid(16)}` }));
    const result = await createMany({ ...args, data: rows });
    peerAlertIds.push(...rows.map((row) => row.id));
    return result;
  }) as unknown as typeof createMany);
  const createNotification = other.notification.create.bind(other.notification);
  const peerNotificationTracking = vi.spyOn(other.notification, 'create').mockImplementation((async (args: Prisma.NotificationCreateArgs) => {
    const result = await createNotification(args);
    peerNotificationIds.push(result.id);
    return result;
  }) as unknown as typeof createNotification);
  let closed = false;
  try {
    // Same stable fixture label AND phone range, different run ownership.
    const peer = await other.user.create({ data: {
      id: peerId, phone: peerRun.nextPhone(), firstName: 'Golden', lastName: 'Peer',
      roles: ['CUSTOMER'], activeRole: 'CUSTOMER', countryCode: 'GY',
    } });
    const before = await other.alertDelivery.create({ data: { ...data, id: beforeId } });
    await h.start();
    expect(await other.user.findUnique({ where: { id: peerId } })).toEqual(peer);
    const customer = await h.actor();
    expect(customer.phone).not.toBe(peer.phone);
    const admin = await h.actor(['ADMIN']);
    const inserted = await h.sys(() => h.app.prisma.alertDelivery.createMany({ data: [
      { ...data, id: ownedAlertIds[0] },
      { ...data, id: ownedAlertIds[1], recipientId: admin.userId },
      { ...data, id: beforeId }, // skipped peer row must never become ours
    ], skipDuplicates: true }));
    expect(inserted.count).toBe(2);
    const during = await other.alertDelivery.create({ data: { ...data, id: duringId } });

    // Exercise the real post-provision fan-out. This vendor belongs to the peer
    // run, but its ADMIN_OPS alert is legitimately addressed to OUR fixture admin.
    const partner = new PartnerService(other, new NotificationService(other, h.app.io));
    const vendor = await partner.becomePartner(peerId, { role: 'VENDOR', business: {
      name: 'Golden Peer Store', vendorType: 'STORE', phone: peer.phone,
      addressLine1: '7 Golden Lane', city: 'Georgetown', region: 'Demerara-Mahaica',
      latitude: 6.8, longitude: -58.15,
    } });
    expect(vendor).toMatchObject({ kind: 'VENDOR', created: true });
    const fanout = await other.alertDelivery.findMany({ where: {
      id: { in: peerAlertIds }, kind: 'ADMIN_OPS', subjectId: 'vendor_pending', recipientId: admin.userId,
    } });
    expect(fanout).toHaveLength(1);
    expect(await other.notification.count({ where: {
      userId: admin.userId, data: { path: ['vendorId'], equals: vendor.id },
    } })).toBe(1);
    const peerAdminNotice = await other.notification.findFirstOrThrow({ where: {
      userId: admin.userId, data: { path: ['vendorId'], equals: vendor.id },
    } });
    // Deliberately fan out BEFORE checking our inserts: concurrent delivery to
    // the same admin must not contaminate the two-row ownership assertion.
    const own = await other.alertDelivery.findMany({ where: { id: { in: ownedAlertIds } } });
    expect(own).toHaveLength(2);
    const rider = await h.actor(['RIDER']);
    const peerOffer = await other.alertDelivery.create({ data: {
      id: peerOfferId, kind: 'MOVER_OFFER', subjectId: `${peerId}-order`, recipientId: rider.userId,
    } });
    // Single inserts and non-admin bulk inserts to external recipients must
    // also be removed even though subject/recipient discovery cannot find them.
    const single = await h.sys(() => h.app.prisma.alertDelivery.create({ data: {
      kind: 'MOVER_OFFER', subjectId: `${recipientId}-order`, recipientId,
    } }));
    ownedAlertIds.push(single.id);
    const bulkId = `gold7-owned-bulk-${nanoid(16)}`;
    expect(await h.sys(() => h.app.prisma.alertDelivery.createMany({ data: {
      id: bulkId, kind: 'VENDOR_ORDER', subjectId: `${recipientId}-order`, recipientId,
    } }))).toEqual({ count: 1 });
    ownedAlertIds.push(bulkId);
    // This test owns the peer user too, so its inbox survives h's user cascade.
    // Shared payload subjects must not give h ownership of a peer insert.
    const noticeData = { userId: peerId, type: 'SYSTEM_ANNOUNCEMENT' as const, title: 'Golden notice', body: 'Fixture only', data: { userId: admin.userId } };
    const peerNotice = await other.notification.create({ data: noticeData });
    const ownNotice = await h.sys(() => h.app.prisma.notification.create({ data: noticeData }));
    ownedNotificationIds.push(ownNotice.id);
    const bulkNoticeId = `gold7-notification-${nanoid(16)}`;
    expect(await h.sys(() => h.app.prisma.notification.createMany({ data: [
      { ...noticeData, id: bulkNoticeId }, { ...noticeData, id: peerNotice.id },
    ], skipDuplicates: true }))).toEqual({ count: 1 });
    ownedNotificationIds.push(bulkNoticeId);
    expect(await other.notification.count({ where: { id: { in: ownedNotificationIds } } })).toBe(2);
    const peerBeforeClose = await other.user.findUniqueOrThrow({ where: { id: peerId } });
    const vendorBeforeClose = await other.vendor.findUniqueOrThrow({ where: { id: vendor.id } });
    await expect(h.close()).rejects.toThrow(/untracked notifications block fixture user cleanup/);
    expect(await other.notification.findUnique({ where: { id: peerAdminNotice.id } })).toEqual(peerAdminNotice);
    expect(await other.user.findUnique({ where: { id: admin.userId } })).not.toBeNull();
    // The peer owns its notice and removes it. Insert another peer notice
    // after the first preflight, while cleanup is already in progress.
    await other.notification.delete({ where: { id: peerAdminNotice.id } });
    const findNotices = h.app.prisma.notification.findMany.bind(h.app.prisma.notification);
    let lateNoticeId: string | undefined;
    const interleave = vi.spyOn(h.app.prisma.notification, 'findMany').mockImplementation((async (args: Prisma.NotificationFindManyArgs) => {
      const result = await findNotices(args);
      if (lateNoticeId) return result;
      const late = await other.notification.create({ data: {
        userId: admin.userId, type: 'SYSTEM_ANNOUNCEMENT', title: 'Late peer notice', body: 'Fixture only',
      } });
      lateNoticeId = late.id;
      return result;
    }) as typeof findNotices);
    try {
      await expect(h.close()).rejects.toThrow(/untracked notifications block fixture user cleanup/);
      expect(lateNoticeId).toBeDefined();
      expect(await other.notification.findUnique({ where: { id: lateNoticeId! } })).not.toBeNull();
      expect(await other.user.findUnique({ where: { id: admin.userId } })).not.toBeNull();
    } finally { interleave.mockRestore(); }
    await other.notification.delete({ where: { id: lateNoticeId! } });
    await h.close(); closed = true;
    expect(await other.alertDelivery.findUnique({ where: { id: peerOfferId } })).toEqual(peerOffer);
    expect(await other.alertDelivery.findUnique({ where: { id: fanout[0]!.id } })).toEqual(fanout[0]);
    expect(await other.alertDelivery.findUnique({ where: { id: duringId } })).toEqual(during);
    expect(await other.alertDelivery.findUnique({ where: { id: beforeId } })).toEqual(before);
    expect(await other.alertDelivery.count({ where: { id: { in: ownedAlertIds } } })).toBe(0);
    expect(await other.notification.count({ where: { id: { in: ownedNotificationIds } } })).toBe(0);
    expect(await other.notification.findUnique({ where: { id: peerNotice.id } })).toEqual(peerNotice);
    expect(await other.user.findUnique({ where: { id: admin.userId } })).toBeNull();
    expect(await other.user.findUnique({ where: { id: peerId } })).toEqual(peerBeforeClose);
    expect(await other.vendor.findUnique({ where: { id: vendor.id } })).toEqual(vendorBeforeClose);
  } finally {
    try {
      if (!closed && h.app) await h.close();
    } finally {
      peerTracking.mockRestore();
      peerNotificationTracking.mockRestore();
      try {
        await other.alertDelivery.deleteMany({ where: { id: { in: [beforeId, duringId, peerOfferId, ...peerAlertIds, ...ownedAlertIds] } } });
        const stores = await other.vendor.findMany({ where: { owner: { userId: peerId } }, select: { id: true } });
        await other.notification.deleteMany({ where: { id: { in: peerNotificationIds } } });
        await other.vendor.deleteMany({ where: { id: { in: stores.map((store) => store.id) } } });
        await other.vendorOwner.deleteMany({ where: { userId: peerId } });
        await other.user.deleteMany({ where: { id: peerId } });
      } finally { await other.$disconnect(); }
    }
  }
});

it('refuses to remove a fixture vendor while a peer order belongs to it', async () => {
  const other = new PrismaClient();
  const h = createGolden('+5920978', 'gold7-cleanup-order');
  const peerRun = createGolden('+5920978', 'gold7-cleanup-order');
  const peerId = `gold7-peer-customer-${nanoid(16)}`;
  let orderId: string | undefined;
  let closed = false;
  try {
    await h.start();
    const owner = await h.actor(['VENDOR_OWNER']);
    const store = await h.vendor(owner);
    await other.user.create({ data: {
      id: peerId, phone: peerRun.nextPhone(), firstName: 'Golden', lastName: 'Peer',
      roles: ['CUSTOMER'], activeRole: 'CUSTOMER', countryCode: 'GY',
    } });
    const order = await other.order.create({ data: {
      orderNumber: `G7PEER-${nanoid(10)}`, orderType: 'FOOD_DELIVERY',
      fulfillment: 'DELIVERY', customerId: peerId, vendorId: store.vendorId,
      status: 'PENDING', deliveryAddress: 'Peer Lane', deliveryLat: 6.8, deliveryLng: -58.15,
      subtotalBase: 1200, subtotalMarkup: 0, subtotalCustomer: 1200,
      deliveryFee: 0, totalAmount: 1200, paymentMethod: 'CASH',
    } });
    orderId = order.id;
    await expect(h.close()).rejects.toThrow(`foreign orders block fixture cleanup: ${orderId}`);
    expect(await other.order.findUnique({ where: { id: orderId } })).toEqual(order);
    expect(await other.vendor.findUnique({ where: { id: store.vendorId } })).not.toBeNull();
    await other.order.delete({ where: { id: orderId } });
    await h.close(); closed = true;
    expect(await other.user.findUnique({ where: { id: peerId } })).not.toBeNull();
  } finally {
    if (orderId) await other.order.deleteMany({ where: { id: orderId } });
    if (!closed && h.app) await h.close().catch(() => {});
    await other.user.deleteMany({ where: { id: peerId } });
    await other.$disconnect();
  }
});

// AX395-1: SET NULL on either mover FK must never detach a peer's order.
it.each(['RIDER', 'DRIVER'] as const)('refuses existing and post-preflight peer orders assigned to a fixture %s without partial cleanup', async (role) => {
  const other = new PrismaClient();
  const h = createGolden('+5920978', `gold7-cleanup-${role.toLowerCase()}`);
  const peerId = `gold7-peer-${nanoid(16)}`;
  const peerOrders: string[] = [];
  let closed = false;
  try {
    await h.start();
    const mover = await h.actor([role]);
    const profile = await h.sys(async () => role === 'RIDER'
      ? await h.app.prisma.rider.create({ data: { userId: mover.userId, riderType: 'BOTH', vehicleType: 'MOTORCYCLE' } })
      : await h.app.prisma.driver.create({ data: { userId: mover.userId, vehicleMake: 'Test', vehicleModel: 'Fixture', vehicleYear: 2026, vehicleColor: 'Blue', licensePlate: `G7-${nanoid(8)}`, driverLicenseUrl: 'https://example.invalid/fixture-license', vehicleInsuranceUrl: 'https://example.invalid/fixture-insurance' } }));
    const ownedAlert = await h.sys(() => h.app.prisma.alertDelivery.create({ data: {
      kind: 'MOVER_OFFER', subjectId: `owned-${nanoid(16)}`, recipientId: mover.userId,
    } }));
    await other.user.create({ data: {
      id: peerId, phone: h.nextPhone(), firstName: 'Golden', lastName: 'Peer', roles: ['CUSTOMER'], activeRole: 'CUSTOMER',
    } });
    const insertPeer = async () => {
      const order = await other.order.create({ data: {
        orderNumber: `G7PEER-${nanoid(16)}`, orderType: 'COURIER', fulfillment: 'DELIVERY',
        customerId: peerId, ...(role === 'RIDER' ? { riderId: profile.id } : { driverId: profile.id }),
        status: 'RIDER_ASSIGNED', deliveryAddress: 'Peer Lane', deliveryLat: 6.8, deliveryLng: -58.15,
        subtotalBase: 0, subtotalMarkup: 0, subtotalCustomer: 0, deliveryFee: 1200, totalAmount: 1200, paymentMethod: 'CASH',
      } });
      peerOrders.push(order.id);
      return order;
    };
    const readProfile = () => role === 'RIDER'
      ? other.rider.findUnique({ where: { id: profile.id } })
      : other.driver.findUnique({ where: { id: profile.id } });
    const existing = await insertPeer();
    await expect(h.close().then(() => { closed = true; })).rejects.toThrow(`foreign orders block fixture cleanup: ${existing.id}`);
    expect(await other.order.findUnique({ where: { id: existing.id } })).toEqual(existing);
    expect(await readProfile()).toEqual(profile);
    expect(await other.alertDelivery.findUnique({ where: { id: ownedAlert.id } })).toEqual(ownedAlert);
    await other.order.delete({ where: { id: existing.id } });

    const findOrders = h.app.prisma.order.findMany.bind(h.app.prisma.order);
    let late: typeof existing | undefined;
    const interleave = vi.spyOn(h.app.prisma.order, 'findMany').mockImplementation((async (args: Prisma.OrderFindManyArgs) => {
      const result = await findOrders(args);
      if (!late) late = await insertPeer(); // empty preflight already read; peer commits before cleanup continues
      return result;
    }) as typeof findOrders);
    try {
      await expect(h.close().then(() => { closed = true; })).rejects.toThrow(/foreign orders block fixture cleanup/);
      expect(late).toBeDefined();
      expect(await other.order.findUnique({ where: { id: late!.id } })).toEqual(late);
      expect(await readProfile()).toEqual(profile);
      expect(await other.alertDelivery.findUnique({ where: { id: ownedAlert.id } })).toEqual(ownedAlert);
    } finally { interleave.mockRestore(); }
    await other.order.delete({ where: { id: late!.id } });
    await h.close(); closed = true;
    expect(await readProfile()).toBeNull();
    expect(await other.alertDelivery.findUnique({ where: { id: ownedAlert.id } })).toBeNull();
  } finally {
    await other.order.deleteMany({ where: { id: { in: peerOrders } } });
    if (!closed && h.app) await h.close();
    await other.user.deleteMany({ where: { id: peerId } });
    await other.$disconnect();
  }
});
