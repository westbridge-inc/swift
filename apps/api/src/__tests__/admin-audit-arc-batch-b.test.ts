import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { prismaPlugin, runWithoutTenant } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { adminRoutes } from '../modules/admin/admin.routes';
import { registerErrorHandler } from '../middleware/error-handler';
import { registerEmptyJsonBodyParser } from '../plugins/empty-json';
import { purgeAuditLogs, purgeSensitiveReadLogs } from '../lib/audit-immutability';
import { injectWithApproval, cleanupSecondApprovers } from './helpers/admin-approval';
import { refusalName, refuseAuditWhere, allowAuditAgain, dropAuditRefusal } from './helpers/audit-refusal';

// ---------------------------------------------------------------------------
// [ADM-002] ARC BATCH B — the settlement digest, the top-up command, the three
// claim decisions and the invoice settlement take the audit into their
// transactions. Two of these (top-up, invoice) already wrote their own row
// inside the transaction while the hook wrote a second; the claim transition
// was a bare compare-and-set with the audit row an afterthought behind it.
// ---------------------------------------------------------------------------

let app: FastifyInstance;
const RUN = nanoid(8).replace(/[^a-zA-Z0-9]/g, '0').toLowerCase();
const REFUSAL = refusalName('arcb');
const userIds: string[] = [];
const vendorIds: string[] = [];
const ownerIds: string[] = [];
const orderIds: string[] = [];
const riderIds: string[] = [];
const adIds = { advertiser: [] as string[], placement: [] as string[], campaign: [] as string[] };
let token = '';
const REASON = 'Week 36 close, finance ticket GY-7100';

const call = (m: string, u: string, p?: unknown, extra: Record<string, string> = {}) => injectWithApproval(app, {
  method: m as never, url: u,
  headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-swift-reason': REASON, ...extra },
  ...(p === undefined ? {} : { payload: p as Record<string, unknown> }) });

const rowsFor = (entityId: string) => runWithoutTenant(() => app.prisma.auditLog.findMany({
  where: { userId: userIds[0]!, entityId }, orderBy: { createdAt: 'asc' } }), 'read');
const changesOf = (row: { changes: unknown }) => row.changes as Record<string, unknown>;
const changedOf = (row: { changes: unknown }) => (changesOf(row)['changed'] ?? {}) as Record<string, { from: unknown; to: unknown }>;

async function person(role: 'CUSTOMER' | 'RIDER' | 'VENDOR_OWNER', tag: string) {
  const u = await app.prisma.user.create({ data: {
    phone: `+5926${String(600000 + Math.floor(Math.random() * 399999))}`, firstName: 'B', lastName: `${tag}${RUN}${nanoid(3)}`,
    roles: [role], activeRole: role, status: 'ACTIVE', isPhoneVerified: true } });
  userIds.push(u.id); return u;
}
async function freshVendor() {
  const ownerUser = await person('VENDOR_OWNER', 'Own');
  const owner = await app.prisma.vendorOwner.create({ data: { userId: ownerUser.id } }); ownerIds.push(owner.id);
  const vendor = await app.prisma.vendor.create({ data: {
    ownerId: owner.id, name: `B Kitchen ${RUN} ${nanoid(3)}`, slug: `arcb-${RUN}-${nanoid(5).toLowerCase()}`, vendorType: 'RESTAURANT',
    phone: `+59271${String(Math.floor(Math.random() * 90000) + 10000)}`, addressLine1: '2 Audit Row', city: 'Georgetown',
    region: 'Demerara-Mahaica', latitude: 6.8, longitude: -58.15, status: 'ACTIVE', acceptingOrders: true, isVerified: true } });
  vendorIds.push(vendor.id); return vendor;
}
async function digest(vendorId: string) {
  return app.prisma.settlement.create({ data: {
    vendorId, kind: 'DIGEST', sequence: 0, status: 'PENDING', totalOrders: 3, totalBase: 12000, totalMarkup: 0, totalDiscount: 0, netSales: 12000,
    periodStart: new Date(Date.now() - 7 * 86_400_000), periodEnd: new Date() } });
}
async function subscription(vendorId: string) {
  return app.prisma.subscription.create({ data: {
    vendorId, type: 'RESTAURANT', status: 'ACTIVE', weeklyRate: 2100, billingMethod: 'CASH',
    currentPeriodStart: new Date(), currentPeriodEnd: new Date(Date.now() + 7 * 86_400_000), nextBillingDate: new Date(Date.now() + 7 * 86_400_000) } });
}
const RESERVE_NOTE = 'arc-batch-b fixture reserve';
async function claim(status: 'PENDING_REVIEW' | 'APPROVED', vendorId: string) {
  const customer = await person('CUSTOMER', 'Cust');
  const riderUser = await person('RIDER', 'Rider');
  const rider = await app.prisma.rider.create({ data: { userId: riderUser.id, riderType: 'DELIVERY', vehicleType: 'MOTORCYCLE' } });
  riderIds.push(rider.id);
  const order = await app.prisma.order.create({ data: {
    orderNumber: `ARCB-${RUN}-${nanoid(6)}`, orderType: 'FOOD_DELIVERY', customerId: customer.id, vendorId, riderId: rider.id,
    status: 'CANCELLED', deliveryAddress: 'x', deliveryLat: 6.8, deliveryLng: -58.15,
    subtotalBase: 1700, subtotalMarkup: 0, subtotalCustomer: 1700, deliveryFee: 300, totalAmount: 2000, paymentMethod: 'CASH' } });
  orderIds.push(order.id);
  // [DOC-1 §31.4 · P31-1] A payable claim carries its evidence bundle — arrival, pickup, cart, door
  // photo — and is drawn from a funded reserve line. Each fixture claim funds its own payout.
  await app.prisma.orderStatusLog.createMany({ data: [
    { orderId: order.id, status: 'PICKED_UP', changedBy: rider.id, note: 'fixture pickup', createdAt: new Date(Date.now() - 40 * 60_000) },
    { orderId: order.id, status: 'ARRIVED', changedBy: rider.id, note: 'fixture arrival', createdAt: new Date(Date.now() - 10 * 60_000) },
  ] });
  const item = await app.prisma.item.findFirst({ where: { vendorId }, select: { id: true } })
    ?? await app.prisma.item.create({ data: { vendorId, categoryId: (await app.prisma.category.create({ data: { vendorId, name: 'Menu', sortOrder: 0 } })).id, name: 'Plate', basePrice: 1700 } as never, select: { id: true } });
  await app.prisma.orderItem.create({ data: { orderId: order.id, itemId: item.id, name: 'Plate', quantity: 1, basePrice: 1700, markedUpPrice: 1700, markupAmount: 0, totalBase: 1700, totalMarkup: 0, totalCustomer: 1700, selectedOptions: {} } as never });
  await app.prisma.rlpReserveEntry.create({ data: { countryCode: 'GY', kind: 'ADJUSTMENT', amount: 2000, note: RESERVE_NOTE } });
  return app.prisma.reimbursementClaim.create({ data: {
    orderId: order.id, riderId: rider.id, customerId: customer.id, amount: 2000, reason: 'no_show', gpsLat: 6.8, gpsLng: -58.15, photoUrl: 'storage://t/door.jpg', status, flags: [] } });
}
async function unpaidInvoice() {
  const a = await app.prisma.advertiser.create({ data: { companyName: `ArcB ${nanoid(6)}`, industry: 'RETAIL', contactName: 'C', contactEmail: `${nanoid(6)}@x.gy`, contactPhone: '+5926000001', createdByUserId: `u-${nanoid(6)}`, status: 'APPROVED' } });
  adIds.advertiser.push(a.id);
  const p = await app.prisma.adPlacement.create({ data: { key: `arcb-${nanoid(6)}`, name: `P ${nanoid(4)}`, tier: 3, mediaKind: 'IMAGE', weeklyPrice: 7000, slotsPerWeek: 6 } });
  adIds.placement.push(p.id);
  const week = new Date('2026-11-02T00:00:00Z');
  const c = await app.prisma.adCampaign.create({ data: { advertiserId: a.id, placementId: p.id, name: `Camp ${nanoid(4)}`, cities: ['*'], startWeek: week, endWeek: week, status: 'PENDING_PAYMENT', totalAmount: 7000 } });
  adIds.campaign.push(c.id);
  await app.prisma.adBooking.create({ data: { campaignId: c.id, placementId: p.id, city: '*', weekStart: week, amount: 7000, status: 'RESERVED' } });
  return app.prisma.adInvoice.create({ data: { advertiserId: a.id, campaignId: c.id, number: `ADS-ARCB-${nanoid(8)}`, amount: 7000, status: 'UNPAID', provider: 'MOCK', refundedAmount: 0 } });
}

beforeAll(async () => {
  app = Fastify({ logger: false });
  registerErrorHandler(app); registerEmptyJsonBodyParser(app);
  await app.register(prismaPlugin); await app.register(redisPlugin);
  await app.register(authPlugin); await app.register(socketPlugin);
  await app.register(adminRoutes, { prefix: '/api/v1/admin' });
  await app.ready();
  const admin = await app.prisma.user.create({ data: {
    phone: `+59272${String(Math.floor(Math.random() * 90000) + 10000)}`,
    firstName: 'ArcB', lastName: `Admin${RUN}`, roles: ['SUPER_ADMIN', 'CUSTOMER'],
    activeRole: 'SUPER_ADMIN', status: 'ACTIVE', isPhoneVerified: true,
    admin: { create: { permissions: ['*'] } } } });
  userIds.push(admin.id);
  token = app.jwt.sign({ userId: admin.id, role: 'SUPER_ADMIN', jti: nanoid(8) });
  await app.prisma.session.create({ data: {
    userId: admin.id, token, refreshToken: nanoid(48), authMethod: 'OTP',
    deviceId: 'arcb', deviceType: 'test', expiresAt: new Date(Date.now() + 86_400_000) } });
});

afterAll(async () => {
  // [P31-1] reserve draws of this suite's payouts first, then its funding entries
  await app.prisma.rlpReserveEntry.deleteMany({ where: { OR: [{ claim: { orderId: { in: orderIds } } }, { note: RESERVE_NOTE }] } });
  await dropAuditRefusal(app, REFUSAL);
  await cleanupSecondApprovers(app);
  await runWithoutTenant(async () => {
    await app.prisma.privilegedApproval.deleteMany({ where: { requestedBy: { in: userIds } } }).catch(() => {});
    await app.prisma.adInvoice.deleteMany({ where: { campaignId: { in: adIds.campaign } } }).catch(() => {});
    await app.prisma.adBooking.deleteMany({ where: { campaignId: { in: adIds.campaign } } }).catch(() => {});
    await app.prisma.adsAuditLog.deleteMany({ where: { entityId: { in: adIds.campaign } } }).catch(() => {});
    await app.prisma.adCampaign.deleteMany({ where: { id: { in: adIds.campaign } } }).catch(() => {});
    await app.prisma.adPlacement.deleteMany({ where: { id: { in: adIds.placement } } }).catch(() => {});
    await app.prisma.advertiser.deleteMany({ where: { id: { in: adIds.advertiser } } }).catch(() => {});
    await app.prisma.reimbursementClaim.deleteMany({ where: { orderId: { in: orderIds } } }).catch(() => {});
    await app.prisma.orderStatusLog.deleteMany({ where: { orderId: { in: orderIds } } }).catch(() => {});
    await app.prisma.order.deleteMany({ where: { id: { in: orderIds } } }).catch(() => {});
    await app.prisma.rider.deleteMany({ where: { id: { in: riderIds } } }).catch(() => {});
    await app.prisma.topUpCommand.deleteMany({ where: { adminId: { in: userIds } } }).catch(() => {});
    await app.prisma.billingEvent.deleteMany({ where: { subscription: { vendorId: { in: vendorIds } } } }).catch(() => {});
    await app.prisma.prepaidBalance.deleteMany({ where: { subscription: { vendorId: { in: vendorIds } } } }).catch(() => {});
    await app.prisma.subscription.deleteMany({ where: { vendorId: { in: vendorIds } } }).catch(() => {});
    await app.prisma.settlement.deleteMany({ where: { vendorId: { in: vendorIds } } }).catch(() => {});
    await app.prisma.vendor.deleteMany({ where: { id: { in: vendorIds } } }).catch(() => {});
    await app.prisma.vendorOwner.deleteMany({ where: { id: { in: ownerIds } } }).catch(() => {});
    await purgeSensitiveReadLogs(app.prisma, { actorUserId: { in: userIds } }, 'arcb').catch(() => 0);
    await purgeAuditLogs(app.prisma, { userId: { in: userIds } }, 'arcb').catch(() => 0);
    await app.prisma.session.deleteMany({ where: { userId: { in: userIds } } }).catch(() => {});
    await app.prisma.admin.deleteMany({ where: { userId: { in: userIds } } }).catch(() => {});
    await app.prisma.customer.deleteMany({ where: { userId: { in: userIds } } }).catch(() => {});
    await app.prisma.user.deleteMany({ where: { id: { in: userIds } } }).catch(() => {});
  }, 'arcb');
  await app.close();
});

describe('[ADM-002] the sales digest', () => {
  it('acknowledging records the reference as a diff; the legacy row is gone', async () => {
    const v = await freshVendor(); const d = await digest(v.id);
    const res = await call('PUT', `/api/v1/admin/finance/settlements/${d.id}/process`, { reference: `ACK-${RUN}` });
    expect(res.statusCode, res.body).toBe(200);
    const rows = await rowsFor(d.id);
    expect(rows.length).toBe(1);
    expect(changedOf(rows[0]!)['status']?.to).toBe('ACKNOWLEDGED');
    expect(changedOf(rows[0]!)['reference']?.to).toBe(`ACK-${RUN}`);
    expect(rows.some((r) => r.action === 'ACKNOWLEDGE_SALES_DIGEST')).toBe(false);
  });
  it('a refused audit leaves the digest PENDING', async () => {
    const v = await freshVendor(); const d = await digest(v.id);
    await refuseAuditWhere(app, REFUSAL, { entityId: d.id });
    try {
      const res = await call('PUT', `/api/v1/admin/finance/settlements/${d.id}/process`, { reference: `ACK-${RUN}-R` });
      expect(res.statusCode, res.body).toBe(500);
    } finally { await allowAuditAgain(app, REFUSAL); }
    expect((await app.prisma.settlement.findUniqueOrThrow({ where: { id: d.id } })).status).toBe('PENDING');
  });
  it('an adjustment names the new row, its sequence and what it supersedes', async () => {
    const v = await freshVendor(); const d = await digest(v.id);
    const res = await call('POST', `/api/v1/admin/finance/settlements/${d.id}/adjust`, { reason: 'ledger recount after a voided order' });
    expect(res.statusCode, res.body).toBe(200);
    const rows = await rowsFor(d.id);
    expect(rows.length).toBe(1);
    expect(typeof changesOf(rows[0]!)['adjustmentId']).toBe('string');
    expect(changesOf(rows[0]!)['sequence']).toBe(1);
    expect(changesOf(rows[0]!)['supersedesId']).toBe(d.id);
    expect(rows.some((r) => r.action === 'ADJUST_SALES_DIGEST')).toBe(false);
  });
});

describe('[ADM-002] the top-up command', () => {
  it('writes ONE canonical row inside the command transaction — no PREPAID_TOPUP duplicate', async () => {
    const v = await freshVendor(); const sub = await subscription(v.id);
    const res = await call('POST', `/api/v1/admin/subscriptions/${sub.id}/topup`, { amount: 5000, reference: `MMG${RUN}A1` }, { 'idempotency-key': `arcb-${RUN}-topup-1` });
    expect(res.statusCode, res.body).toBe(200);
    const rows = await rowsFor(sub.id);
    expect(rows.length).toBe(1);
    expect(changesOf(rows[0]!)['amount']).toBe(5000);
    expect(typeof changesOf(rows[0]!)['billingEventId']).toBe('string');
    expect(rows.some((r) => r.action === 'PREPAID_TOPUP')).toBe(false);
  });
  it('a refused audit rolls the whole command back — balance, event, command row', async () => {
    const v = await freshVendor(); const sub = await subscription(v.id);
    await refuseAuditWhere(app, REFUSAL, { entityId: sub.id });
    try {
      const res = await call('POST', `/api/v1/admin/subscriptions/${sub.id}/topup`, { amount: 5000, reference: `MMG${RUN}B1` }, { 'idempotency-key': `arcb-${RUN}-topup-2` });
      expect(res.statusCode, res.body).toBe(500);
    } finally { await allowAuditAgain(app, REFUSAL); }
    expect(await app.prisma.billingEvent.count({ where: { subscriptionId: sub.id } })).toBe(0);
    expect(await app.prisma.topUpCommand.count({ where: { subscriptionId: sub.id } })).toBe(0);
  });
});

describe('[ADM-002] claim decisions', () => {
  it('approve and reject record the transition as a diff', async () => {
    const v = await freshVendor();
    const a = await claim('PENDING_REVIEW', v.id);
    const approve = await call('PUT', `/api/v1/admin/cash-rules/claims/${a.id}/approve`, { reason: REASON });
    expect(approve.statusCode, approve.body).toBe(200);
    const ra = await rowsFor(a.id);
    expect(ra.length).toBe(1);
    expect(changedOf(ra[0]!)['status']?.to).toBe('APPROVED');
    expect(ra.some((r) => r.action === 'APPROVE_CLAIM')).toBe(false);
    const b = await claim('PENDING_REVIEW', v.id);
    const reject = await call('PUT', `/api/v1/admin/cash-rules/claims/${b.id}/reject`, { reason: 'photo shows a different door' });
    expect(reject.statusCode, reject.body).toBe(200);
    const rb = await rowsFor(b.id);
    expect(rb.length).toBe(1);
    expect(changedOf(rb[0]!)['status']?.to).toBe('REJECTED');
  });
  it('paid: the payout evidence is the diff — reference and attested amount', async () => {
    const v = await freshVendor(); const c = await claim('APPROVED', v.id);
    const res = await call('PUT', `/api/v1/admin/cash-rules/claims/${c.id}/paid`, { reference: `MMG${RUN}P1`, amount: 2000 });
    expect(res.statusCode, res.body).toBe(200);
    const rows = await rowsFor(c.id);
    expect(rows.length).toBe(1);
    expect(changedOf(rows[0]!)['status']?.to).toBe('PAID');
    // the rail normalises references to upper case before they are stored
    expect(changedOf(rows[0]!)['paymentRef']?.to).toBe(`MMG${RUN}P1`.toUpperCase());
    expect(String(changedOf(rows[0]!)['paidAmount']?.to)).toMatch(/^2000(\.0+)?$/);
    expect(rows.some((r) => r.action === 'CLAIM_PAID' || r.action === 'MARK_CLAIM_PAID')).toBe(false);
  });
  it('paid: a refused audit leaves the claim APPROVED with no reference', async () => {
    const v = await freshVendor(); const c = await claim('APPROVED', v.id);
    await refuseAuditWhere(app, REFUSAL, { entityId: c.id });
    try {
      const res = await call('PUT', `/api/v1/admin/cash-rules/claims/${c.id}/paid`, { reference: `MMG${RUN}P2`, amount: 2000 });
      expect(res.statusCode, res.body).toBe(500);
    } finally { await allowAuditAgain(app, REFUSAL); }
    const fresh = await app.prisma.reimbursementClaim.findUniqueOrThrow({ where: { id: c.id } });
    expect(fresh.status).toBe('APPROVED');
    expect(fresh.paymentRef).toBeNull();
  });
});

describe('[ADM-002] invoice settlement', () => {
  it('marking an invoice paid writes ONE canonical row inside the settlement transaction', async () => {
    const inv = await unpaidInvoice();
    const res = await call('PUT', `/api/v1/admin/ads/invoices/${inv.id}/mark-paid`, { reference: `BANK-${RUN}-INV1` });
    expect(res.statusCode, res.body).toBe(200);
    const rows = await rowsFor(inv.id);
    expect(rows.length).toBe(1);
    expect(changedOf(rows[0]!)['status']?.to).toBe('PAID');
    expect(changesOf(rows[0]!)['outcome']).toBe('settled');
    expect(changesOf(rows[0]!)['confirmedBookings']).toBe(1);
  });
  it('a refused audit leaves the invoice UNPAID, the booking RESERVED and the campaign PENDING_PAYMENT', async () => {
    const inv = await unpaidInvoice();
    await refuseAuditWhere(app, REFUSAL, { entityId: inv.id });
    try {
      const res = await call('PUT', `/api/v1/admin/ads/invoices/${inv.id}/mark-paid`, { reference: `BANK-${RUN}-INV2` });
      expect(res.statusCode, res.body).toBe(500);
    } finally { await allowAuditAgain(app, REFUSAL); }
    expect((await app.prisma.adInvoice.findUniqueOrThrow({ where: { id: inv.id } })).status).toBe('UNPAID');
    expect(await app.prisma.adBooking.count({ where: { campaignId: inv.campaignId, status: 'RESERVED' } })).toBe(1);
    expect((await app.prisma.adCampaign.findUniqueOrThrow({ where: { id: inv.campaignId } })).status).toBe('PENDING_PAYMENT');
  });
});
