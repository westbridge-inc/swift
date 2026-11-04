import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import type { UserRole } from '@prisma/client';
import { buildApp } from '../app';
import { AuthService } from '../modules/auth/auth.service';
import { runWithoutTenant } from '../plugins/prisma';
import { issueSyntheticHandoverPhoto, persistSessionFix } from './helpers/handover-proof';
import { retainedPhonePrefix } from './helpers/retained-evidence';

// ---------------------------------------------------------------------------
// [BUG-HUNT F18] A parcel is goods, and the rider was told the same words as for food: finish it and the account comes
// back. A parcel closes through the courier proof, not the rider handover, so these cases run the real logout and the
// real proof with a real issued door photo, whoever pays. A job that fails at the door was not delivered and stays
// with a person. Issued proofs are retained evidence, so this suite deletes neither them nor the people they name.
// ---------------------------------------------------------------------------

const CENTRAL = { lat: 6.81, lng: -58.155 };
const SOUTH = { lat: 6.755, lng: -58.155 };
const DAY = 86_400_000;
const LIFT = 'delivery-custody-lift';
const PHONE_PREFIX = retainedPhonePrefix('52');
const ORDER_BODY = {
  pickup: CENTRAL, dropoff: SOUTH, pickupAddress: '12 Sender Street', dropoffAddress: '34 Recipient Avenue', packageSize: 'MEDIUM' as const,
  speed: 'STANDARD' as const, recipientName: 'Recipient', recipientPhone: '+5926001234',
};
const sys = <T>(fn: () => Promise<T>) => runWithoutTenant(fn, 'test-parcel-lift');

let app: FastifyInstance;
const userIds: string[] = [];
let seq = 0;
let doorSeq = 0;
const RUN_DROP_OFFSET = Math.floor(Math.random() * 90) * 0.0001;

async function makeUser(roles: UserRole[], activeRole: UserRole) {
  seq += 1;
  const user = await app.prisma.user.create({
    data: {
      phone: `${PHONE_PREFIX}${String(seq).padStart(3, '0')}`, firstName: 'Parcel', lastName: `Lift${seq}`, roles, activeRole, status: 'ACTIVE',
      isPhoneVerified: true, selfieCapturedAt: new Date(), trustLevel: 'L2', countryCode: 'GY',
      ...(roles.includes('CUSTOMER') ? { customer: { create: {} } } : {}),
    },
  });
  userIds.push(user.id);
  return user;
}

async function signIn(userId: string, role: string) {
  const token = app.jwt.sign({ userId, role, jti: nanoid(8) });
  const session = await app.prisma.session.create({
    data: { userId, token, refreshToken: nanoid(48), deviceId: `parcel-${nanoid(6)}`, deviceType: 'test', expiresAt: new Date(Date.now() + DAY) },
  });
  return { token, sessionId: session.id };
}

const post = (url: string, token: string, payload: Record<string, unknown>) => app.inject({
  method: 'POST', url: `/api/v1/courier${url}`, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, payload,
});

/** A parcel in the rider's custody, the session gone or not, and the rider signed in with a fresh fix at the drop-off. */
async function parcelInCustody(payer: 'SENDER' | 'RECIPIENT', opts: { logOut: boolean }) {
  const sender = await makeUser(['CUSTOMER'], 'CUSTOMER');
  const senderToken = (await signIn(sender.id, 'CUSTOMER')).token;
  const created = await post('/order', senderToken, { ...ORDER_BODY, payer });
  expect(created.statusCode, created.body).toBeLessThan(300);
  const orderId = created.json().data.orderId as string;

  const user = await makeUser(['RIDER', 'CUSTOMER'], 'RIDER');
  const first = await signIn(user.id, 'RIDER');
  const rider = await app.prisma.rider.create({
    data: { userId: user.id, riderType: 'DELIVERY', vehicleType: 'MOTORCYCLE', documentsVerified: true, isOnline: true, locationSessionId: first.sessionId, currentOrderId: orderId },
  });
  let drop = { lat: 0, lng: 0 };
  for (;;) {
    doorSeq += 1;
    drop = { lat: Number((SOUTH.lat + RUN_DROP_OFFSET + doorSeq * 0.01).toFixed(4)), lng: Number((SOUTH.lng - doorSeq * 0.01).toFixed(4)) };
    if (await app.prisma.strike.count({ where: { addressKey: `geo:${drop.lat.toFixed(4)}:${drop.lng.toFixed(4)}` } }) === 0) break;
  }
  await app.prisma.order.update({ where: { id: orderId }, data: { riderId: rider.id, status: 'PICKED_UP', deliveryLat: drop.lat, deliveryLng: drop.lng } });
  if (payer === 'SENDER') {
    const collected = await post(`/order/${orderId}/collect`, first.token, { outcome: 'paid', gps: CENTRAL });
    expect(collected.statusCode, collected.body).toBe(200);
  }
  let token = first.token;
  let sessionId = first.sessionId;
  if (opts.logOut) {
    await new AuthService(app).logoutAll(user.id);
    expect((await app.prisma.rider.findUniqueOrThrow({ where: { id: rider.id } })).safetySuspendedAt).not.toBeNull();
    ({ token, sessionId } = await signIn(user.id, 'RIDER'));
  }
  await persistSessionFix(app.prisma, { riderId: rider.id }, sessionId, drop);
  const issued = (await issueSyntheticHandoverPhoto(app.prisma, { orderId, actorId: user.id, role: 'RIDER' })).url;
  return { orderId, senderId: sender.id, userId: user.id, riderId: rider.id, token, drop, issued };
}

type Parcel = Awaited<ReturnType<typeof parcelInCustody>>;
const stamp = async (job: Parcel) => (await app.prisma.rider.findUniqueOrThrow({ where: { id: job.riderId } })).safetySuspendedAt;
const liftRows = (job: Parcel) => app.prisma.orderOutbox.findMany({ where: { orderId: job.orderId, kind: LIFT } });

async function expectBack(job: Parcel) {
  expect((await app.prisma.order.findUniqueOrThrow({ where: { id: job.orderId } })).status).toBe('DELIVERED');
  expect(await stamp(job)).toBeNull();
  const kase = await app.prisma.incidentCase.findFirstOrThrow({ where: { orderId: job.orderId, subjectUserId: job.userId } });
  expect(kase.interimAction).toBe('NONE');
  expect(kase.status).toBe('OPEN'); // the case stays with ops
  expect(await app.prisma.notification.count({ where: { userId: job.userId, title: 'Suspension lifted' } })).toBe(1);
  const rows = await liftRows(job);
  expect(rows).toHaveLength(1);
  expect(rows[0]?.processedAt).not.toBeNull();
  // The sender keeps the parcel's own notice: the lift writes nothing to the customer.
  expect(await app.prisma.notification.count({ where: { userId: job.senderId, title: 'Parcel delivered' } })).toBe(1);
  expect(await app.prisma.notification.count({ where: { userId: job.senderId, title: 'Delivered!' } })).toBe(0);
}

beforeAll(async () => {
  vi.stubEnv('RUN_WORKERS', '0'); // requests only: the scheduler would leave recurring jobs on queues other suites read
  app = await buildApp();
  await app.ready();
}, 60_000);

afterAll(async () => {
  await sys(async () => {
    await app.prisma.rider.updateMany({ where: { userId: { in: userIds } }, data: { currentOrderId: null, isOnline: false, isAvailable: false } });
    await app.prisma.moverRevocationOutbox.deleteMany({ where: { userId: { in: userIds } } });
    await app.prisma.incidentCase.deleteMany({ where: { subjectUserId: { in: userIds } } });
  });
  await app?.close();
  vi.unstubAllEnvs();
});

describe('[F18] a parcel is goods: the suspension lifts when it is delivered', () => {
  it('the fee was collected at pickup: the proof delivers it and the rider is back', async () => {
    const job = await parcelInCustody('SENDER', { logOut: true });
    const proof = await post(`/order/${job.orderId}/proof`, job.token, { proofPhotoUrl: job.issued });
    expect(proof.statusCode, proof.body).toBe(200);
    await expectBack(job);
  });

  it('the recipient pays cash at the door: the same proof, the cash door, and the rider is back', async () => {
    const job = await parcelInCustody('RECIPIENT', { logOut: true });
    const proof = await post(`/order/${job.orderId}/proof`, job.token, { proofPhotoUrl: job.issued, outcome: 'paid', gps: job.drop });
    expect(proof.statusCode, proof.body).toBe(200);
    await expectBack(job);
  });
});

describe('[F18] everything else stays as it is', () => {
  it('a parcel that failed at the door was not delivered: still suspended, a person has it', async () => {
    const job = await parcelInCustody('RECIPIENT', { logOut: true });
    const proof = await post(`/order/${job.orderId}/proof`, job.token, { proofPhotoUrl: job.issued, outcome: 'refused', gps: job.drop });
    expect(proof.statusCode, proof.body).toBe(200);
    expect((await app.prisma.order.findUniqueOrThrow({ where: { id: job.orderId } })).status).toBe('FAILED');
    expect(await stamp(job)).not.toBeNull();
    expect(await liftRows(job)).toHaveLength(0);
    expect(await app.prisma.notification.count({ where: { userId: job.userId, title: 'Suspension lifted' } })).toBe(0);
  });

  it('a parcel nobody logged out of owes nothing: no row, nobody told', async () => {
    const job = await parcelInCustody('RECIPIENT', { logOut: false });
    const proof = await post(`/order/${job.orderId}/proof`, job.token, { proofPhotoUrl: job.issued, outcome: 'paid', gps: job.drop });
    expect(proof.statusCode, proof.body).toBe(200);
    expect((await app.prisma.order.findUniqueOrThrow({ where: { id: job.orderId } })).status).toBe('DELIVERED');
    expect(await liftRows(job)).toHaveLength(0);
    expect(await app.prisma.notification.count({ where: { userId: job.userId, title: 'Suspension lifted' } })).toBe(0);
  });
});
