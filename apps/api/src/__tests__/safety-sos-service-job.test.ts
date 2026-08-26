import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import type { UserRole } from '@prisma/client';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { safetyRoutes } from '../modules/safety/safety.routes';
import { registerErrorHandler } from '../middleware/error-handler';

// ---------------------------------------------------------------------------
// [B3] SOS from a SERVICE JOB — the last two uncovered surfaces. A ServiceJob
// is not an order, so the participant rule gets its own clause: exactly the
// job's customer and its provider may raise its SOS; anyone else gets the
// same 404 the order path gives (no existence oracle). Repeats collapse per
// job. The alert row carries serviceJobId so ops sees WHERE the emergency is.
// ---------------------------------------------------------------------------

let app: FastifyInstance;
const DAY = 24 * 60 * 60 * 1000;

const createdUserIds: string[] = [];
let customer: { userId: string; token: string };
let provider: { userId: string; token: string };
let stranger: { userId: string; token: string };
let providerId: string; // ServiceProvider row id
let jobId: string;
const alertIds: string[] = [];

let seq = 0;
async function makeUserWithSession(roles: UserRole[], activeRole: UserRole) {
  seq += 1;
  const user = await app.prisma.user.create({
    data: {
      phone: `+59200797${String(seq).padStart(2, '0')}`,
      firstName: 'SvcSos', lastName: `User${seq}`,
      roles, activeRole,
      isPhoneVerified: true, selfieCapturedAt: new Date(),
      ...(roles.includes('CUSTOMER') && { customer: { create: {} } }),
    },
  });
  createdUserIds.push(user.id);
  const token = app.jwt.sign({ userId: user.id, role: activeRole, jti: nanoid(8) });
  await app.prisma.session.create({
    data: {
      userId: user.id, token, refreshToken: nanoid(48),
      deviceId: 'svc-sos-test', deviceType: 'test',
      expiresAt: new Date(Date.now() + DAY),
    },
  });
  return { userId: user.id, token };
}

function raise(token: string, body: Record<string, unknown>) {
  return app.inject({
    method: 'POST',
    url: '/api/v1/safety/sos',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    payload: body,
  });
}

beforeAll(async () => {
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  await app.register(safetyRoutes, { prefix: '/api/v1/safety' });
  await app.ready();

  // Idempotent purge (house pattern: unique fixture phone prefix per file).
  const stale = await app.prisma.user.findMany({ where: { phone: { startsWith: '+59200797' } }, select: { id: true } });
  if (stale.length) {
    const staleIds = stale.map((s) => s.id);
    await app.prisma.sosAlert.deleteMany({ where: { actorUserId: { in: staleIds } } });
    await app.prisma.serviceJob.deleteMany({ where: { customerId: { in: staleIds } } });
    await app.prisma.serviceProvider.deleteMany({ where: { userId: { in: staleIds } } });
    await app.prisma.session.deleteMany({ where: { userId: { in: staleIds } } });
    await app.prisma.customer.deleteMany({ where: { userId: { in: staleIds } } });
    await app.prisma.user.deleteMany({ where: { id: { in: staleIds } } });
  }

  customer = await makeUserWithSession(['CUSTOMER'], 'CUSTOMER');
  // A provider is any user holding a ServiceProvider row — there is no
  // dedicated UserRole; the SOS authz reads the relation, never the role.
  provider = await makeUserWithSession(['CUSTOMER'], 'CUSTOMER');
  stranger = await makeUserWithSession(['CUSTOMER'], 'CUSTOMER');

  const providerRow = await app.prisma.serviceProvider.create({
    data: { userId: provider.userId, trade: 'Plumber', isVerified: true },
  });
  providerId = providerRow.id;

  const job = await app.prisma.serviceJob.create({
    data: {
      customerId: customer.userId,
      providerId,
      description: 'Fix the kitchen sink',
      status: 'SCHEDULED',
      scheduledFor: new Date(Date.now() + 60 * 60 * 1000),
      providerConfirmedAt: new Date(),
    },
  });
  jobId = job.id;
});

afterAll(async () => {
  await app.prisma.sosAlert.deleteMany({ where: { id: { in: alertIds } } });
  if (jobId) await app.prisma.serviceJob.deleteMany({ where: { id: jobId } });
  if (providerId) await app.prisma.serviceProvider.deleteMany({ where: { id: providerId } });
  if (createdUserIds.length) {
    await app.prisma.sosAlert.deleteMany({ where: { actorUserId: { in: createdUserIds } } });
    await app.prisma.session.deleteMany({ where: { userId: { in: createdUserIds } } });
    await app.prisma.customer.deleteMany({ where: { userId: { in: createdUserIds } } });
    await app.prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  }
  await app.close();
});

describe('SOS on a service job [B3]', () => {
  it('the CUSTOMER on the job raises an alert that records the job and names the provider as counterparty', async () => {
    const res = await raise(customer.token, {
      serviceJobId: jobId, lat: 6.8, lng: -58.15,
      clientIdempotencyKey: `svc-sos-cust-${nanoid(8)}`,
    });
    expect(res.statusCode).toBe(200);
    const { data } = res.json() as { data: { id: string } };
    alertIds.push(data.id);
    const row = await app.prisma.sosAlert.findUniqueOrThrow({ where: { id: data.id } });
    expect(row.serviceJobId).toBe(jobId);
    expect(row.orderId).toBeNull();
    expect(row.counterpartyUserId).toBe(provider.userId);
  });

  it('the PROVIDER on the job raises an alert that names the customer as counterparty', async () => {
    const res = await raise(provider.token, {
      serviceJobId: jobId, lat: 6.81, lng: -58.16,
      clientIdempotencyKey: `svc-sos-prov-${nanoid(8)}`,
    });
    expect(res.statusCode).toBe(200);
    const { data } = res.json() as { data: { id: string } };
    alertIds.push(data.id);
    const row = await app.prisma.sosAlert.findUniqueOrThrow({ where: { id: data.id } });
    expect(row.serviceJobId).toBe(jobId);
    expect(row.counterpartyUserId).toBe(customer.userId);
  });

  it('a STRANGER gets the same 404 as the order path — no existence oracle', async () => {
    const res = await raise(stranger.token, {
      serviceJobId: jobId,
      clientIdempotencyKey: `svc-sos-strange-${nanoid(8)}`,
    });
    expect(res.statusCode).toBe(404);
  });

  it('orderId AND serviceJobId together is refused — an emergency happens in one place', async () => {
    const res = await raise(customer.token, {
      serviceJobId: jobId, orderId: 'any-order',
      clientIdempotencyKey: `svc-sos-both-${nanoid(8)}`,
    });
    expect(res.statusCode).toBe(400);
  });

  it('repeats on the same job COLLAPSE onto the live alert instead of minting rows', async () => {
    const key = `svc-sos-repeat-${nanoid(8)}`;
    const first = await raise(customer.token, { serviceJobId: jobId, clientIdempotencyKey: key, lat: 6.8, lng: -58.15 });
    expect(first.statusCode).toBe(200);
    const firstId = (first.json() as { data: { id: string } }).data.id;
    alertIds.push(firstId);

    // Same actor, same job, NEW key — the per-context live-alert collapse
    // (not the idempotency replay) must absorb it.
    const second = await raise(customer.token, { serviceJobId: jobId, clientIdempotencyKey: `svc-sos-repeat2-${nanoid(8)}`, lat: 6.802, lng: -58.151 });
    expect(second.statusCode).toBe(200);
    const secondId = (second.json() as { data: { id: string } }).data.id;
    expect(secondId).toBe(firstId);
    const row = await app.prisma.sosAlert.findUniqueOrThrow({ where: { id: firstId } });
    expect(row.retriggerCount).toBeGreaterThanOrEqual(1);
  });
});
