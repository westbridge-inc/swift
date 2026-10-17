/**
 * [Row 331 · DSAR-ERASURE (b) · GUARDRAILS §2] The account export is complete and says so truthfully.
 *  - Every category the register names is in the file, read in pages: nothing is cut at 1,000.
 *  - A category past the per-file ceiling is marked incomplete, and the file and notice say so.
 *  - Secrets never leave; a mover gets their work record, never the customer's details.
 *  - The notice no longer claims the file is everything while it leaves things out.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { prismaPlugin } from '../plugins/prisma';
import { AccountService } from '../modules/user/account.service';
import { EXPORT_NOTICE, EXPORT_PARTIAL_NOTICE, exportPersonalData } from '../modules/user/data-export';

let app: FastifyInstance;
const userIds: string[] = [];
const MARK = nanoid(8);
let seq = 0;
const service = () => new AccountService({ prisma: app.prisma, log: app.log, io: {} as never });

beforeAll(async () => {
  process.env['NODE_ENV'] = 'test';
  app = Fastify({ logger: false });
  await app.register(prismaPlugin);
  await app.ready();
});

afterAll(async () => {
  const where = { userId: { in: userIds } };
  await app.prisma.order.deleteMany({ where: { OR: [{ customerId: { in: userIds } }, { rider: where }] } });
  await app.prisma.vendor.deleteMany({ where: { owner: where } });
  await app.prisma.vendorOwner.deleteMany({ where });
  await app.prisma.rider.deleteMany({ where });
  await app.prisma.notification.deleteMany({ where });
  await app.prisma.emergencyContact.deleteMany({ where });
  await app.prisma.deviceToken.deleteMany({ where });
  await app.prisma.session.deleteMany({ where });
  await app.prisma.address.deleteMany({ where });
  await app.prisma.customer.deleteMany({ where });
  await app.prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await app.close();
});

async function person() {
  seq += 1;
  const u = await app.prisma.user.create({ data: {
    phone: `+5926${String(Date.now()).slice(-5)}${String(seq).padStart(2, '0')}`, firstName: 'Export', lastName: `Subject${seq}`,
    roles: ['CUSTOMER'], activeRole: 'CUSTOMER', isPhoneVerified: true, passwordHash: `secret-hash-${MARK}`,
    customer: { create: {} },
  } });
  userIds.push(u.id);
  return u.id;
}

async function store(ownerId: string) {
  const vo = await app.prisma.vendorOwner.create({ data: { userId: ownerId } });
  return app.prisma.vendor.create({ data: {
    ownerId: vo.id, name: `Export Mart ${MARK}`, slug: `export-mart-${MARK}-${ownerId.slice(-6)}`, vendorType: 'SUPERMARKET', phone: '+5926001234',
    addressLine1: '1 Store Street', city: 'Georgetown', region: 'Demerara-Mahaica', latitude: 6.8, longitude: -58.15,
  } });
}

const order = (customerId: string, vendorId: string, i: number, extra: Record<string, unknown> = {}) => ({
  orderNumber: `EXP-${MARK}-${i}`, orderType: 'FOOD_DELIVERY' as const, customerId, vendorId, status: 'DELIVERED' as const,
  deliveryAddress: `${i} Customer Street`, deliveryLat: 6.8, deliveryLng: -58.15,
  subtotalBase: 1000, subtotalMarkup: 0, subtotalCustomer: 1000, deliveryFee: 300, totalAmount: 1300, paymentMethod: 'CASH' as const, ...extra,
});

describe('the account export', () => {
  it('holds every order, not the first 1,000, and says the file is complete', async () => {
    const userId = await person();
    const owner = await person();
    const v = await store(owner);
    await app.prisma.order.createMany({ data: Array.from({ length: 1_001 }, (_, i) => order(userId, v.id, i)) });
    const data = await service().exportData(userId) as unknown as Record<string, unknown> & { orders: unknown[] };
    expect(data.orders).toHaveLength(1_001);
    expect(data).toMatchObject({ complete: true, coverage: { orders: { rows: 1_001, complete: true } } });
  });

  it('holds the categories the old file never had, and no secret', async () => {
    const userId = await person();
    const token = `session-token-${MARK}`;
    await app.prisma.session.create({ data: { userId, token, refreshToken: `refresh-${MARK}`, deviceId: 'device-1', deviceType: 'android', expiresAt: new Date(Date.now() + 86_400_000) } });
    await app.prisma.deviceToken.create({ data: { userId, token: `push-${MARK}`, platform: 'android' } });
    await app.prisma.notification.create({ data: { userId, type: 'SYSTEM_ANNOUNCEMENT', title: 'Hello', body: 'A notification' } });
    await app.prisma.emergencyContact.create({ data: { userId, name: 'Sis', phoneE164: '+5926000002' } });
    const data = await service().exportData(userId) as unknown as Record<string, unknown[]>;
    expect(data['sessions']).toEqual([expect.objectContaining({ deviceType: 'android' })]);
    expect(data['devices']).toEqual([expect.objectContaining({ platform: 'android' })]);
    expect(data['notifications']).toEqual([expect.objectContaining({ title: 'Hello' })]);
    expect(data['emergencyContacts']).toEqual([expect.objectContaining({ name: 'Sis' })]);
    // An empty column is left out (the file goes to the share sheet as one text).
    expect(data['emergencyContacts']![0]).not.toHaveProperty('verifiedAt');
    const text = JSON.stringify(data);
    for (const secret of [token, `refresh-${MARK}`, `push-${MARK}`, `secret-hash-${MARK}`]) expect(text).not.toContain(secret);
  });

  it('marks a category past the ceiling as incomplete; the file and the notice say so', async () => {
    const userId = await person();
    for (const label of ['Home', 'Work', 'Gym']) {
      await app.prisma.address.create({ data: { userId, label, addressLine1: `${label} Road`, city: 'Georgetown', region: 'Demerara-Mahaica', latitude: 6.8, longitude: -58.1 } });
    }
    const data = await exportPersonalData(app.prisma, userId, { ceiling: 2 });
    expect((data as unknown as Record<string, unknown[]>)['addresses']).toHaveLength(2);
    expect(data.coverage['addresses']).toEqual({ rows: 2, complete: false });
    expect(data.complete).toBe(false);
    expect(data.notice.startsWith(EXPORT_PARTIAL_NOTICE)).toBe(true);
    const whole = await exportPersonalData(app.prisma, userId);
    expect(whole).toMatchObject({ complete: true, notice: EXPORT_NOTICE, coverage: { addresses: { rows: 3, complete: true } } });
  });

  it('tells the truth about what it leaves out', async () => {
    const userId = await person();
    const data = await service().exportData(userId) as { notice: string; withheld: Array<{ reason: string; what: string; records: string[] }> };
    expect(data.notice).not.toContain('This is the personal data Swift holds about your account');
    expect(data.withheld.map((w) => w.reason).sort()).toEqual(['FRAUD_SAFETY', 'LEGAL_HOLD', 'OTHER_PEOPLE', 'STAFF_WORK', 'SYSTEM']);
    for (const w of data.withheld) expect(w.records.length).toBeGreaterThan(0);
  });

  it('gives a rider their work record, never the customer’s address', async () => {
    const riderUser = await person();
    const customer = await person();
    const owner = await person();
    const v = await store(owner);
    const rider = await app.prisma.rider.create({ data: { userId: riderUser, riderType: 'DELIVERY', vehicleType: 'MOTORCYCLE' } });
    await app.prisma.order.create({ data: order(customer, v.id, 9_999, { riderId: rider.id, deliveredAt: new Date() }) });
    const data = await service().exportData(riderUser) as unknown as Record<string, unknown[]>;
    expect(data['deliveriesAsRider']).toEqual([expect.objectContaining({ orderNumber: `EXP-${MARK}-9999`, deliveryFee: expect.anything() })]);
    expect(JSON.stringify(data)).not.toContain('9999 Customer Street');
    expect(data['orders']).toEqual([]);
  });
});
