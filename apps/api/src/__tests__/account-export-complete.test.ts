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
import { wordFreeTag } from './helpers/fixture-ids';

let app: FastifyInstance;
const userIds: string[] = [];
const MARK = wordFreeTag(8);
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
  await app.prisma.driver.deleteMany({ where });
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
    // A customer's app shows no single rating, so neither does the file (COORD 18 Oct): no words, no rater role,
    // and a rating only inside a whole group of 5 (this person has one shown rating, so no group yet).
    expect(data['ratingsReceived']).toEqual([]);
    expect(data['ratingsReceivedInGroups']).toEqual([]);
    // The live rating summary moves with each single rating: withheld (one partition only, rating-groups.ts).
    expect(data['ratingSummary']).toBeUndefined();
    expect(data['chatMessagesSent']).toEqual([expect.objectContaining({ message: `from a ${MARK}` })]);
    const text = JSON.stringify(data);
    for (const leak of [b, rider.id, `kind and quick ${MARK}`, `still hidden ${MARK}`, `from b ${MARK}`, `not folded yet ${MARK}`, 'RIDER_TO_CUSTOMER', '"lifetimeCount"', '"rollingSum"', '"topNegativeTags"', '"displayRating"']) expect(text).not.toContain(leak);
  });

  // COORD rulings 17 Oct 23:38Z + 18 Oct (option S): only a store's reviews are listed one by one. Every other rating
  // a person received is given ONLY in whole groups of 5 final ratings (rating-groups.ts), the one cut the app shows.
  const daysAgo = (d: number) => new Date(Date.now() - d * 86_400_000);
  const month = (d: Date) => d.toISOString().slice(0, 7);
  type Received = { type: 'CUSTOMER_TO_RIDER' | 'CUSTOMER_TO_DRIVER' | 'CUSTOMER_TO_PROVIDER' | 'RIDER_TO_CUSTOMER'; score: number; at: Date; extra?: Record<string, unknown> };
  async function received(rateeId: string, ratings: Received[]) {
    const rater = await person();
    const owner = await person();
    const v = await store(owner);
    for (const [i, r] of ratings.entries()) {
      const o = await app.prisma.order.create({ data: order(rater, v.id, 7_200 + seq * 20 + i) });
      const createdAt = new Date(r.at.getTime() + i * 1_000);
      await app.prisma.rating.create({ data: {
        orderId: o.id, raterId: rater, rateeId, type: r.type, score: r.score, comment: `words ${i} ${MARK}`, tags: [`tag${i}-${MARK}`],
        visibleAt: new Date(), createdAt, editableUntil: new Date(createdAt.getTime() + 7 * 86_400_000), ...r.extra,
      } });
    }
    return rater;
  }
  const leaks = (text: string, rater: string) => {
    for (let i = 0; i < 14; i++) for (const leak of [`words ${i} ${MARK}`, `tag${i}-${MARK}`]) expect(text).not.toContain(leak);
    for (const leak of ['CUSTOMER_TO_RIDER', 'CUSTOMER_TO_DRIVER', 'CUSTOMER_TO_PROVIDER', 'RIDER_TO_CUSTOMER', rater]) expect(text).not.toContain(leak);
  };
  const groupsOf = async (userId: string) => ((await service().exportData(userId)) as unknown as Record<string, unknown>)['ratingsReceivedInGroups'];

  it('gives ratings received only in whole groups of 5, per role, with their months and average', async () => {
    const ratee = await person();
    const at = daysAgo(40);
    const rater = await received(ratee, [
      ...[5, 1, 4, 2, 3, 5, 5].map((score) => ({ type: 'CUSTOMER_TO_RIDER' as const, score, at })), // 7: one group (the first 5)
      ...[4, 4, 5, 3, 4].map((score) => ({ type: 'RIDER_TO_CUSTOMER' as const, score, at })), // as a customer
      ...[2, 5].map((score) => ({ type: 'CUSTOMER_TO_DRIVER' as const, score, at })), // 2: no group yet
    ]);
    const data = await service().exportData(ratee) as unknown as Record<string, unknown>;
    expect(data['ratingsReceivedInGroups']).toEqual([
      { as: 'CUSTOMER', from: month(at), to: month(at), count: 5, scoreAverage: 4 },
      { as: 'RIDER', from: month(at), to: month(at), count: 5, scoreAverage: 3 },
    ]);
    expect(data['ratingsReceived']).toEqual([]);
    leaks(JSON.stringify(data), rater);
  });

  it('two exports never differ by one rating: the groups move only by a whole new group of 5 (the difference attack)', async () => {
    const ratee = await person();
    await received(ratee, [3, 3, 3, 3, 3].map((score) => ({ type: 'CUSTOMER_TO_RIDER' as const, score, at: daysAgo(30) })));
    const first = await groupsOf(ratee) as unknown[];
    expect(first).toEqual([{ as: 'RIDER', from: month(daysAgo(30)), to: month(daysAgo(30)), count: 5, scoreAverage: 3 }]);
    // One more final rating, a 1: the file is the same, so nothing can be subtracted to find it.
    await received(ratee, [{ type: 'CUSTOMER_TO_RIDER', score: 1, at: daysAgo(20) }]);
    expect(await groupsOf(ratee)).toEqual(first);
    // Four more: a whole new group appears; the first is unchanged.
    await received(ratee, [5, 5, 5, 5].map((score) => ({ type: 'CUSTOMER_TO_RIDER' as const, score, at: daysAgo(10) })));
    expect(await groupsOf(ratee)).toEqual([first[0], { as: 'RIDER', from: month(daysAgo(20)), to: month(daysAgo(10)), count: 5, scoreAverage: 4.2 }]);
  });

  it('a rating still open to editing holds back everything after it; an excluded one never counts', async () => {
    const ratee = await person();
    await received(ratee, [
      ...[4, 4, 4, 4].map((score) => ({ type: 'CUSTOMER_TO_PROVIDER' as const, score, at: daysAgo(30) })),
      { type: 'CUSTOMER_TO_PROVIDER', score: 1, at: daysAgo(29), extra: { state: 'EXCLUDED' } }, // counted, it would close a group
      { type: 'CUSTOMER_TO_PROVIDER', score: 2, at: daysAgo(3) }, // still editable (7-day window)
    ]);
    expect(await groupsOf(ratee)).toEqual([]);
    await app.prisma.rating.updateMany({ where: { rateeId: ratee, score: 2 }, data: { editableUntil: daysAgo(1) } });
    expect(await groupsOf(ratee)).toEqual([{ as: 'SERVICE_PROVIDER', from: month(daysAgo(30)), to: month(daysAgo(3)), count: 5, scoreAverage: 3.6 }]);
    const data = await service().exportData(ratee) as unknown as { notice: string };
    expect(data.notice).toContain('Ratings you received as a customer, rider, driver or provider are given only in groups of 5, in the order they came: '
      + 'for each group, the months it spans and its average score. The newest appear once a whole group can no longer be edited (about a week after '
      + 'its last rating). Never one by one: never the words, the tags, who gave them or for which trip.');
  });

  it('a mover never gets the live rating totals: they move with each single rating', async () => {
    const userId = await person();
    await app.prisma.rider.create({ data: { userId, riderType: 'DELIVERY', vehicleType: 'MOTORCYCLE', averageRating: 4.3, totalRatings: 41 } });
    const data = await service().exportData(userId) as unknown as Record<string, Array<Record<string, unknown>>>;
    expect(data['riderProfile']).toHaveLength(1);
    expect(data['riderProfile']![0]).not.toHaveProperty('averageRating');
    expect(data['riderProfile']![0]).not.toHaveProperty('totalRatings');
    expect(JSON.stringify(data)).not.toMatch(/"(averageRating|totalRatings)"/);
    expect((data as unknown as { notice: string }).notice).toContain('running rating totals, which change with each single rating (your ratings are given in groups of 5 instead)');
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
      if ('id' in w || 'userId' in w || 'subjectId' in w || 'rateeId' in w) { expect(mine.has(String(w['id'] ?? w['userId'] ?? w['subjectId'] ?? w['rateeId'])), call.model).toBe(true); continue; }
      const match = personMatch(call.where);
      expect(match.length, call.model).toBeGreaterThan(0);
      for (const clause of match) {
        const values = Object.values(clause);
        expect(values, call.model).toHaveLength(1);
        // A child table read through its parent (a ride's stops through the ride): one relation, then one person column.
        const leaf = values[0] !== null && typeof values[0] === 'object' ? Object.values(values[0] as Record<string, unknown>) : values;
        expect(leaf, call.model).toHaveLength(1);
        expect(mine.has(String(leaf[0])), `${call.model} ${JSON.stringify(clause)}`).toBe(true);
      }
    }
  });

  it('gives a passenger the places their taxi rides stopped at, with the ride; never another passenger’s, who moved a stop or the driver’s evidence (REVIEW-M S3-1)', async () => {
    const passenger = await person();
    const other = await person();
    const driverUser = await person();
    const driver = await app.prisma.driver.create({ data: { userId: driverUser, vehicleMake: 'Synthetic', vehicleModel: 'Car', vehicleYear: 2025, vehicleColor: 'Blue', licensePlate: `EX${nanoid(5)}`, driverLicenseUrl: '', vehicleInsuranceUrl: '' } });
    const taxi = (customerId: string, i: number) => ({
      orderNumber: `EXP-${MARK}-T${i}`, orderType: 'TAXI' as const, customerId, driverId: driver.id, status: 'DELIVERED' as const, taxiStopCount: 2,
      pickupAddress: `${i} Pickup Road`, pickupLat: 6.81, pickupLng: -58.16, deliveryAddress: `${i} Drop Road`, deliveryLat: 6.79, deliveryLng: -58.12,
      subtotalBase: 1500, subtotalMarkup: 0, subtotalCustomer: 1500, deliveryFee: 0, totalAmount: 1500, paymentMethod: 'CASH' as const,
    });
    const ride = await app.prisma.order.create({ data: taxi(passenger, 8_001) });
    const theirs = await app.prisma.order.create({ data: taxi(other, 8_002) });
    const at = new Date(Date.now() - 3_600_000);
    await app.prisma.taxiTripStop.create({ data: {
      orderId: ride.id, sequence: 1, lat: 6.8012, lng: -58.1503, address: `Stop One ${MARK}`, legMeters: 1200, legSeconds: 240,
      status: 'DEPARTED', arrivedAt: at, arrivalVerified: true, departedAt: new Date(at.getTime() + 300_000), actedBy: driverUser, evidenceNote: `fix 40 m from the stop ${MARK}`,
    } });
    await app.prisma.taxiTripStop.create({ data: {
      orderId: ride.id, sequence: 2, lat: 6.7955, lng: -58.1402, address: `Stop Two ${MARK}`, status: 'SKIPPED', skippedAt: at, skipReason: 'Couldn’t reach the stop', actedBy: driverUser,
    } });
    await app.prisma.taxiTripStop.create({ data: { orderId: theirs.id, sequence: 1, lat: 6.8, lng: -58.15, address: `Their Stop ${MARK}` } });
    const data = await service().exportData(passenger) as unknown as Record<string, Array<Record<string, unknown>>> & { coverage: Record<string, unknown> };
    expect(data['taxiStops']).toEqual([
      expect.objectContaining({ orderId: ride.id, sequence: 1, address: `Stop One ${MARK}`, lat: 6.8012, lng: -58.1503, legMeters: 1200, legSeconds: 240, status: 'DEPARTED', arrivalVerified: true }),
      expect.objectContaining({ orderId: ride.id, sequence: 2, address: `Stop Two ${MARK}`, lat: 6.7955, lng: -58.1402, status: 'SKIPPED', skipReason: 'Couldn’t reach the stop' }),
    ]);
    // No arrival, no verified claim (an empty column is left out, like every other).
    expect(data['taxiStops']![1]).not.toHaveProperty('arrivalVerified');
    expect(data.coverage['taxiStops']).toEqual({ rows: 2, complete: true });
    // The ride they belong to is in "orders" under the same id.
    expect(data['orders']).toEqual([expect.objectContaining({ id: ride.id, taxiStopCount: 2 })]);
    const text = JSON.stringify(data);
    for (const leak of [`Their Stop ${MARK}`, theirs.id, driverUser, `fix 40 m from the stop ${MARK}`, '"actedBy"', '"evidenceNote"', '"tenantId"']) expect(text).not.toContain(leak);
    // The driver gets their trips, never the passengers' stops.
    const driverData = await service().exportData(driverUser) as unknown as Record<string, unknown[]>;
    expect(driverData['tripsAsDriver']).toHaveLength(2);
    expect(driverData['taxiStops']).toEqual([]);
    for (const leak of [`Stop One ${MARK}`, `Stop Two ${MARK}`, `Their Stop ${MARK}`]) expect(JSON.stringify(driverData)).not.toContain(leak);
  });

  // [REVIEW-M S3 on #2027 · follow-up] For a sole trader the store's phone, email, address and map pin can be the
  // owner's own contact and home place: the owner's file carries the record of each store they OWN (read through the
  // ownership), with what they set for it. Never another owner's store, never a store they only work at, never a
  // staff note, a hold or who placed it.
  it('gives a store owner the record of each store they own: contact, place, payment details and settings; never another owner’s store or a staff note', async () => {
    const owner = await person();
    const otherOwner = await person();
    const worker = await person();
    // [REVIEW-G2 S4-1 on #2078] The staff member who placed a checkout hold is another person: never in the owner's file.
    const holdPlacer = await person();
    const mine = await store(owner);
    const theirs = await store(otherOwner);
    await app.prisma.vendor.update({ where: { id: mine.id }, data: {
      email: `owner-${MARK}@example.test`, addressLine2: `Back Room ${MARK}`, publicPhone: '+5926001299', mmgNumber: '+5926001288',
      refundRule: `Refunds within a day ${MARK}`, tradesUnderOwnName: true, tierNote: `staff note ${MARK}`, mmgCheckoutHeldReason: `held for review ${MARK}`, mmgCheckoutHeldAt: new Date(),
      mmgCheckoutHeldById: holdPlacer,
    } });
    await app.prisma.vendor.update({ where: { id: theirs.id }, data: { addressLine1: `Their Street ${MARK}`, email: `theirs-${MARK}@example.test` } });
    await app.prisma.vendorStaff.create({ data: { vendorId: mine.id, userId: worker, role: 'STAFF', invitedBy: owner } });

    const data = await service().exportData(owner) as unknown as Record<string, Array<Record<string, unknown>>> & { coverage: Record<string, unknown> };
    expect(data['storesOwned']).toEqual([expect.objectContaining({
      id: mine.id, name: mine.name, vendorType: 'SUPERMARKET', phone: '+5926001234', publicPhone: '+5926001299', email: `owner-${MARK}@example.test`,
      addressLine1: '1 Store Street', addressLine2: `Back Room ${MARK}`, city: 'Georgetown', region: 'Demerara-Mahaica', latitude: 6.8, longitude: -58.15,
      mmgNumber: '+5926001288', refundRule: `Refunds within a day ${MARK}`,
      // [ROLE-DOCS #2046 · second merger] the owner's own declared name basis is their own setting
      tradesUnderOwnName: true,
    })]);
    expect(data.coverage['storesOwned']).toEqual({ rows: 1, complete: true });
    const text = JSON.stringify(data);
    for (const leak of [theirs.id, `Their Street ${MARK}`, `theirs-${MARK}@example.test`, `staff note ${MARK}`, `held for review ${MARK}`, '"tierNote"', '"mmgCheckoutHeldAt"', '"tenantId"', '"ownerId"', holdPlacer, '"mmgCheckoutHeldById"']) {
      expect(text, leak).not.toContain(leak);
    }
    // Someone who only works at the store gets no store record.
    const workerData = await service().exportData(worker) as unknown as Record<string, unknown[]>;
    expect(workerData['storesOwned']).toEqual([]);
    expect(JSON.stringify(workerData)).not.toContain(`Back Room ${MARK}`);
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
