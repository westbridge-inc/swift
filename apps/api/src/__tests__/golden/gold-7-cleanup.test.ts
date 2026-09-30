import { Prisma, PrismaClient } from '@prisma/client';
import { nanoid } from 'nanoid';
import { expect, it, vi } from 'vitest';
import { NotificationService } from '../../modules/notification/notification.service';
import { PartnerService } from '../../modules/partner/partner.service';
import { createGolden } from './gold-7-helpers';

// [G7-01] Cleanup isolation, not a journey. A concurrent writer can use the
// same admin subject and recipient. Before/after census is not ownership.
// Phone +5920978nnn: source/range-audited; no other fixture uses this prefix.
it('removes only exact run-inserted alerts of every kind and preserves peer fan-out and mover offers', async () => {
  const other = new PrismaClient();
  const h = createGolden('+5920978', 'gold7-cleanup');
  const recipientId = `gold7-external-${nanoid(12)}`;
  const beforeId = `gold7-before-${nanoid(12)}`;
  const peerOfferId = `gold7-peer-offer-${nanoid(12)}`;
  const duringId = `gold7-during-${nanoid(12)}`;
  const peerId = `gold7-cleanup-${nanoid(16)}-${nanoid(12)}`;
  const peerAlertIds: string[] = [];
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
  let closed = false;
  try {
    // Same stable fixture label AND phone range, different run ownership.
    const peer = await other.user.create({ data: {
      id: peerId, phone: '+5920978999', firstName: 'Golden', lastName: 'Peer',
      roles: ['CUSTOMER'], activeRole: 'CUSTOMER', countryCode: 'GY',
    } });
    const before = await other.alertDelivery.create({ data: { ...data, id: beforeId } });
    await h.start();
    expect(await other.user.findUnique({ where: { id: peerId } })).toEqual(peer);
    await h.actor();
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
    const peerBeforeClose = await other.user.findUniqueOrThrow({ where: { id: peerId } });
    const vendorBeforeClose = await other.vendor.findUniqueOrThrow({ where: { id: vendor.id } });
    await h.close(); closed = true;
    expect(await other.alertDelivery.findUnique({ where: { id: peerOfferId } })).toEqual(peerOffer);
    expect(await other.alertDelivery.findUnique({ where: { id: fanout[0]!.id } })).toEqual(fanout[0]);
    expect(await other.alertDelivery.findUnique({ where: { id: duringId } })).toEqual(during);
    expect(await other.alertDelivery.findUnique({ where: { id: beforeId } })).toEqual(before);
    expect(await other.alertDelivery.count({ where: { id: { in: ownedAlertIds } } })).toBe(0);
    expect(await other.user.findUnique({ where: { id: admin.userId } })).toBeNull();
    expect(await other.user.findUnique({ where: { id: peerId } })).toEqual(peerBeforeClose);
    expect(await other.vendor.findUnique({ where: { id: vendor.id } })).toEqual(vendorBeforeClose);
  } finally {
    try {
      if (!closed && h.app) await h.close();
    } finally {
      peerTracking.mockRestore();
      try {
        await other.alertDelivery.deleteMany({ where: { id: { in: [beforeId, duringId, peerOfferId, ...peerAlertIds, ...ownedAlertIds] } } });
        const stores = await other.vendor.findMany({ where: { owner: { userId: peerId } }, select: { id: true } });
        for (const store of stores) {
          await other.notification.deleteMany({ where: { data: { path: ['vendorId'], equals: store.id } } });
        }
        await other.vendor.deleteMany({ where: { id: { in: stores.map((store) => store.id) } } });
        await other.vendorOwner.deleteMany({ where: { userId: peerId } });
        await other.user.deleteMany({ where: { id: peerId } });
      } finally { await other.$disconnect(); }
    }
  }
});
