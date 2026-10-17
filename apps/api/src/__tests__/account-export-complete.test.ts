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
const rooms: string[] = [];
const service = () => new AccountService({ prisma: app.prisma, log: app.log, io: {} as never });

beforeAll(async () => {
  process.env['NODE_ENV'] = 'test';
  app = Fastify({ logger: false });
  await app.register(prismaPlugin);
  await app.ready();
});

afterAll(async () => {
  const where = { userId: { in: userIds } };
  await app.prisma.chatMessage.deleteMany({ where: { senderId: { in: userIds } } });
  await app.prisma.chatRoom.deleteMany({ where: { id: { in: rooms } } });
  await app.prisma.rating.deleteMany({ where: { raterId: { in: userIds } } });
  await app.prisma.actorRatingStat.deleteMany({ where: { subjectId: { in: userIds } } });
  await app.prisma.livenessCheck.deleteMany({ where });
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

describe('the account export route', () => {
  it('is rate-limited per person (each export is ~60 reads)', async () => {
    const { readFileSync } = await import('node:fs'); const { join } = await import('node:path');
    const routes = readFileSync(join(__dirname, '..', 'modules', 'user', 'customer.routes.ts'), 'utf8');
    expect(routes).toContain("app.get('/account/export', { config: { rateLimit: { max: 3, timeWindow: '1 hour' } } }");
  });
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

  it('tells the truth about what it leaves out, and never lists the fraud checks', async () => {
    const userId = await person();
    const data = await service().exportData(userId) as unknown as { notice: string; withheld: Array<{ reason: string; what: string; records?: string[] }> };
    expect(data.notice).not.toContain('This is the personal data Swift holds about your account');
    expect(data.withheld.map((w) => w.reason).sort()).toEqual(['FRAUD_SAFETY', 'LEGAL_HOLD', 'OTHER_PEOPLE', 'STAFF_WORK', 'SYSTEM']);
    for (const w of data.withheld) {
      if (w.reason === 'FRAUD_SAFETY') expect(w).not.toHaveProperty('records'); // named in general only
      else expect(w.records!.length).toBeGreaterThan(0);
    }
  });

  it('holds only the person: ratings received without who gave them, own messages only, nothing still double-blind', async () => {
    const a = await person();
    const b = await person();
    const owner = await person();
    const v = await store(owner);
    const rider = await app.prisma.rider.create({ data: { userId: b, riderType: 'DELIVERY', vehicleType: 'MOTORCYCLE' } });
    const shown = await app.prisma.order.create({ data: order(a, v.id, 7_001, { riderId: rider.id }) });
    const blind = await app.prisma.order.create({ data: order(a, v.id, 7_002, { riderId: rider.id }) });
    const threeDaysAgo = new Date(Date.now() - 3 * 86_400_000);
    await app.prisma.rating.create({ data: { orderId: shown.id, raterId: b, rateeId: a, type: 'RIDER_TO_CUSTOMER', score: 4, comment: `kind and quick ${MARK}`, visibleAt: new Date(), createdAt: threeDaysAgo } });
    await app.prisma.rating.create({ data: { orderId: blind.id, raterId: b, rateeId: a, type: 'RIDER_TO_CUSTOMER', score: 1, comment: `still hidden ${MARK}`, createdAt: threeDaysAgo } });
    // Shown, but given after the last daily fold: it would pair with today's one trip, so it waits.
    const fresh = await app.prisma.order.create({ data: order(a, v.id, 7_004, { riderId: rider.id }) });
    await app.prisma.rating.create({ data: { orderId: fresh.id, raterId: b, rateeId: a, type: 'RIDER_TO_CUSTOMER', score: 2, comment: `not folded yet ${MARK}`, visibleAt: new Date() } });
    // The summary is the folded view only: never the live counts, sums or tags.
    await app.prisma.actorRatingStat.create({ data: { subjectRole: 'CUSTOMER', subjectId: a, lifetimeCount: 3, lifetimeSum: 7, rollingCount: 3, rollingSum: 7, displayRating: 4.0, topNegativeTags: ['late'], actorVisibleAt: new Date(Date.now() - 86_400_000) } });
    const room = await app.prisma.chatRoom.create({ data: { orderId: shown.id } });
    rooms.push(room.id);
    await app.prisma.chatMessage.create({ data: { chatRoomId: room.id, senderId: a, message: `from a ${MARK}` } });
    await app.prisma.chatMessage.create({ data: { chatRoomId: room.id, senderId: b, message: `from b ${MARK}` } });
    const data = await service().exportData(a) as unknown as Record<string, Array<Record<string, unknown>>>;
    expect(data['ratingsReceived']).toEqual([{ rateeId: a, type: 'RIDER_TO_CUSTOMER', score: 4, comment: `kind and quick ${MARK}`, tags: [], createdAt: expect.stringMatching(/^\d{4}-\d{2}$/) }]);
    // As the file carries it (JSON): Decimals and dates become strings.
    expect(JSON.parse(JSON.stringify(data['ratingSummary']))).toEqual([{ subjectRole: 'CUSTOMER', subjectId: a, displayRating: '4', standing: 'NEW', actorVisibleAt: expect.any(String) }]);
    expect(data['chatMessagesSent']).toEqual([expect.objectContaining({ message: `from a ${MARK}` })]);
    const text = JSON.stringify(data);
    for (const leak of [b, rider.id, `still hidden ${MARK}`, `from b ${MARK}`, `not folded yet ${MARK}`, '"lifetimeCount"', '"rollingSum"', '"topNegativeTags"']) expect(text).not.toContain(leak);
    // The order a rating was for is not named on the rating (it would point at the rater).
    expect(data['ratingsReceived']![0]).not.toHaveProperty('orderId');
  });

  it('lists ratings received in no order that follows the trips (never creation order)', async () => {
    const a = await person();
    const b = await person();
    const owner = await person();
    const v = await store(owner);
    const rider = await app.prisma.rider.create({ data: { userId: b, riderType: 'DELIVERY', vehicleType: 'MOTORCYCLE' } });
    const when = new Date(Date.now() - 3 * 86_400_000);
    for (const [i, score] of [5, 1, 4].entries()) {
      const o = await app.prisma.order.create({ data: order(a, v.id, 7_100 + i, { riderId: rider.id }) });
      await app.prisma.rating.create({ data: { orderId: o.id, raterId: b, rateeId: a, type: 'RIDER_TO_CUSTOMER', score, visibleAt: new Date(), createdAt: new Date(when.getTime() + i * 1_000) } });
    }
    const data = await service().exportData(a) as unknown as Record<string, Array<{ score: number }>>;
    expect(data['ratingsReceived']!.map((r) => r.score)).toEqual([1, 4, 5]); // created 5, 1, 4
  });

  it('never carries security internals or the fraud signals that fired', async () => {
    const userId = await person();
    await app.prisma.user.update({ where: { id: userId }, data: { lossProtectionSuspendedAt: new Date(), lossProtectionSuspendedReason: `velocity hit ${MARK}`, enhancedSafetyMonitoring: true } });
    await app.prisma.session.create({ data: { userId, token: nanoid(24), refreshToken: nanoid(24), deviceId: `device-${MARK}`, deviceType: 'android', expiresAt: new Date(Date.now() + 86_400_000) } });
    await app.prisma.notification.create({ data: { userId, type: 'SYSTEM_ANNOUNCEMENT', title: 'Pay', body: 'Pay your fee', data: { checkoutUrl: `https://pay.example/signed-${MARK}` } } });
    await app.prisma.livenessCheck.create({ data: { userId, profile: 'RIDER', selfieUrl: `liveness/${userId}/x.jpg`, outcome: 'BORDERLINE', score: 0.4321, reviewRequired: true } });
    const owner = await person();
    const v = await store(owner);
    const o = await app.prisma.order.create({ data: order(userId, v.id, 7_003, { riskFlagged: true, riskReason: `collision ${MARK}`, ridePinAttempts: 3, mmgRecipientNameSnapshot: `Payee Fullname ${MARK}` }) });
    // A rating quietly excluded as fake must not tell its author so.
    await app.prisma.rating.create({ data: { orderId: o.id, raterId: userId, vendorId: v.id, type: 'CUSTOMER_TO_VENDOR', score: 5, state: 'EXCLUDED', stateReason: `ring ${MARK}` } });
    const data = await service().exportData(userId) as unknown as Record<string, unknown>;
    const text = JSON.stringify(data);
    for (const leak of [`velocity hit ${MARK}`, `device-${MARK}`, `signed-${MARK}`, `collision ${MARK}`, `Payee Fullname ${MARK}`, '0.4321', `liveness/${userId}`]) expect(text).not.toContain(leak);
    for (const key of ['enhancedSafetyMonitoring', 'reviewRequired', 'riskFlagged', 'ridePinAttempts', 'deviceId', 'state', 'stateReason']) expect(text).not.toContain(`"${key}"`);
    expect((data['ratingsGiven'] as unknown[])).toHaveLength(1);
    expect(text).not.toContain(`ring ${MARK}`);
  });

  it('reads every category only by the person: the register columns, equal to the person ids', async () => {
    const userId = await person();
    const rider = await app.prisma.rider.create({ data: { userId, riderType: 'DELIVERY', vehicleType: 'MOTORCYCLE' } });
    const mine = new Set([userId, rider.id]);
    const calls: Array<{ model: string; where: unknown }> = [];
    const spy = new Proxy(app.prisma, { get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver) as unknown;
      if (typeof prop !== 'string' || !value || typeof value !== 'object' || !('findMany' in value)) return value;
      const delegate = value as { findMany(a: unknown): Promise<unknown>; findUnique?(a: unknown): Promise<unknown> };
      return { ...delegate,
        findMany: (args: { where: unknown }) => { calls.push({ model: prop, where: args.where }); return delegate.findMany(args); },
        findUnique: (args: { where: unknown }) => { calls.push({ model: prop, where: args.where }); return delegate.findUnique!(args); } };
    } });
    await exportPersonalData(spy, userId);
    expect(calls.length).toBeGreaterThan(60);
    const personMatch = (where: unknown): Array<Record<string, unknown>> => {
      const w = where as { OR?: Array<Record<string, unknown>>; AND?: unknown[] };
      if (w.OR) return w.OR;
      return (w.AND ?? []).flatMap((part) => personMatch(part));
    };
    for (const call of calls) {
      const w = call.where as Record<string, unknown>;
      if ('id' in w || 'userId' in w || 'subjectId' in w) { expect(mine.has(String(w['id'] ?? w['userId'] ?? w['subjectId'])), call.model).toBe(true); continue; }
      const match = personMatch(call.where);
      expect(match.length, call.model).toBeGreaterThan(0);
      for (const clause of match) {
        const values = Object.values(clause);
        expect(values, call.model).toHaveLength(1);
        expect(mine.has(String(values[0])), `${call.model} ${JSON.stringify(clause)}`).toBe(true);
      }
    }
  });

  it('gives a rider their work record, never the customer’s address', async () => {
    const riderUser = await person();
    const customer = await person();
    const owner = await person();
    const v = await store(owner);
    const rider = await app.prisma.rider.create({ data: { userId: riderUser, riderType: 'DELIVERY', vehicleType: 'MOTORCYCLE' } });
    await app.prisma.order.create({ data: order(customer, v.id, 9_999, { riderId: rider.id, deliveredAt: new Date() }) });
    // A parcel: the pickup address is the SENDER's own place (courier.routes.ts), not a store.
    await app.prisma.order.create({ data: order(customer, v.id, 9_998, { riderId: rider.id, orderType: 'COURIER', pickupAddress: `Sender Home ${MARK}` }) });
    const data = await service().exportData(riderUser) as unknown as Record<string, unknown[]>;
    expect(data['deliveriesAsRider']).toEqual(expect.arrayContaining([expect.objectContaining({ orderNumber: `EXP-${MARK}-9999`, deliveryFee: expect.anything() })]));
    expect(data['deliveriesAsRider']).toHaveLength(2);
    expect(JSON.stringify(data)).not.toContain('9999 Customer Street');
    expect(JSON.stringify(data)).not.toContain(`Sender Home ${MARK}`);
    expect(data['orders']).toEqual([]);
  });
});
