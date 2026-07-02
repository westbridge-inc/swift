import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import type { UserRole } from '@prisma/client';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { servicesRoutes } from '../modules/services/services.routes';
import { registerErrorHandler } from '../middleware/error-handler';
import { sendBookingReminders } from '../modules/services/services.service';

// ---------------------------------------------------------------------------
// Booking accept/decline + reminders (master plan §4.3). Failure paths first:
// only the provider confirms/declines; declining returns the job to QUOTED
// (never a dead end); each side is reminded exactly ONCE inside 24h and
// unconfirmed slots are never reminded.
// ---------------------------------------------------------------------------

const DAY = 24 * 60 * 60 * 1000;

let app: FastifyInstance;
const createdUserIds: string[] = [];

let seq = 0;
async function makeUser(roles: UserRole[], activeRole: UserRole) {
  seq += 1;
  const user = await app.prisma.user.create({
    data: {
      phone: `+59200348${String(seq).padStart(2, '0')}`,
      firstName: 'Book',
      lastName: `User${seq}`,
      roles,
      activeRole,
      isPhoneVerified: true,
      selfieCapturedAt: new Date(),
      ...(roles.includes('CUSTOMER') && { customer: { create: {} } }),
    },
  });
  createdUserIds.push(user.id);
  const token = app.jwt.sign({ userId: user.id, role: activeRole, jti: nanoid(8) });
  await app.prisma.session.create({
    data: {
      userId: user.id, token, refreshToken: nanoid(48),
      deviceId: 'book-test', deviceType: 'test', expiresAt: new Date(Date.now() + DAY),
    },
  });
  return { userId: user.id, token };
}

function inject(method: 'GET' | 'POST', url: string, payload?: unknown, token?: string) {
  return app.inject({
    method,
    url,
    ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
    headers: {
      ...(payload !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
  });
}

let customer: { userId: string; token: string };
let providerUser: { userId: string; token: string };
let jobId: string;

beforeAll(async () => {
  process.env['NODE_ENV'] = 'development';
  process.env['DATABASE_URL'] = process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift';
  process.env['REDIS_URL'] = process.env['REDIS_URL'] || 'redis://localhost:6382';

  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  await app.register(servicesRoutes, { prefix: '/api/v1/services' });
  await app.ready();

  customer = await makeUser(['CUSTOMER'], 'CUSTOMER');
  providerUser = await makeUser(['CUSTOMER'], 'CUSTOMER');

  const provider = await app.prisma.serviceProvider.create({
    data: { userId: providerUser.userId, trade: 'Plumber', isVerified: true },
  });
  const job = await app.prisma.serviceJob.create({
    data: {
      customerId: customer.userId,
      providerId: provider.id,
      description: 'Fix the kitchen tap, it drips all night',
      status: 'QUOTED',
      quoteAmount: 8000,
    },
  });
  jobId = job.id;
});

afterAll(async () => {
  if (createdUserIds.length > 0) {
    await app.prisma.serviceJob.deleteMany({ where: { customerId: { in: createdUserIds } } });
    await app.prisma.serviceProvider.deleteMany({ where: { userId: { in: createdUserIds } } });
    await app.prisma.notification.deleteMany({ where: { userId: { in: createdUserIds } } });
    await app.prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  }
  await app.close();
});

describe('Provider accepts or declines the slot (§4.3)', () => {
  it('scheduling notifies the provider and awaits their confirmation', async () => {
    const when = new Date(Date.now() + 2 * DAY).toISOString();
    const res = await inject('POST', `/api/v1/services/jobs/${jobId}/schedule`, { scheduledFor: when }, customer.token);
    expect(res.statusCode).toBe(200);
    expect(res.json().data.providerConfirmedAt).toBeNull();

    const note = await app.prisma.notification.findFirst({
      where: { userId: providerUser.userId, title: 'Booking to confirm' },
    });
    expect(note).not.toBeNull();
  });

  it('the customer cannot confirm on behalf of the provider', async () => {
    const res = await inject('POST', `/api/v1/services/jobs/${jobId}/confirm`, {}, customer.token);
    expect(res.statusCode).toBe(403);
  });

  it('declining returns the job to QUOTED with the slot cleared — the customer rebooks', async () => {
    const declined = await inject('POST', `/api/v1/services/jobs/${jobId}/decline-slot`, {}, providerUser.token);
    expect(declined.statusCode).toBe(200);
    expect(declined.json().data.status).toBe('QUOTED');
    expect(declined.json().data.scheduledFor).toBeNull();

    const note = await app.prisma.notification.findFirst({
      where: { userId: customer.userId, title: 'Time didn’t work' },
    });
    expect(note).not.toBeNull();

    // Rebook + confirm this time
    const when = new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString();
    const rebook = await inject('POST', `/api/v1/services/jobs/${jobId}/schedule`, { scheduledFor: when }, customer.token);
    expect(rebook.statusCode).toBe(200);

    const confirmed = await inject('POST', `/api/v1/services/jobs/${jobId}/confirm`, {}, providerUser.token);
    expect(confirmed.statusCode).toBe(200);
    expect(confirmed.json().data.providerConfirmedAt).toBeTruthy();

    const custNote = await app.prisma.notification.findFirst({
      where: { userId: customer.userId, title: 'Booking confirmed' },
    });
    expect(custNote).not.toBeNull();
  });
});

describe('Reminders — once per side inside 24h', () => {
  it('a confirmed job reminds both parties exactly once across repeated sweeps', async () => {
    const notify = async (n: { userId: string; title: string; body: string; data: Record<string, unknown> }) => {
      await app.prisma.notification.create({
        data: { userId: n.userId, type: 'ORDER_UPDATE', title: n.title, body: n.body, data: n.data as object },
      });
    };

    // The sweep is global (other test files may hold their own bookings), so
    // assert on THIS job's two parties rather than the return total.
    await sendBookingReminders(app.prisma, notify);
    const afterFirst = await app.prisma.notification.count({
      where: { userId: { in: [customer.userId, providerUser.userId] }, title: 'Booking tomorrow' },
    });
    expect(afterFirst).toBe(2); // customer + provider, once each

    await sendBookingReminders(app.prisma, notify);
    const afterSecond = await app.prisma.notification.count({
      where: { userId: { in: [customer.userId, providerUser.userId] }, title: 'Booking tomorrow' },
    });
    expect(afterSecond).toBe(2); // dedupe holds
  });

  it('an unconfirmed slot never reminds', async () => {
    const other = await makeUser(['CUSTOMER'], 'CUSTOMER');
    const provider2User = await makeUser(['CUSTOMER'], 'CUSTOMER');
    const provider2 = await app.prisma.serviceProvider.create({
      data: { userId: provider2User.userId, trade: 'Mason', isVerified: true },
    });
    await app.prisma.serviceJob.create({
      data: {
        customerId: other.userId,
        providerId: provider2.id,
        description: 'Wall repair by the gate, two days of work',
        status: 'SCHEDULED',
        quoteAmount: 20000,
        scheduledFor: new Date(Date.now() + 10 * 60 * 60 * 1000),
        providerConfirmedAt: null,
      },
    });

    const notify = async (n: { userId: string; title: string; body: string; data: Record<string, unknown> }) => {
      await app.prisma.notification.create({
        data: { userId: n.userId, type: 'ORDER_UPDATE', title: n.title, body: n.body, data: n.data as object },
      });
    };
    await sendBookingReminders(app.prisma, notify);
    const notes = await app.prisma.notification.count({
      where: { userId: { in: [other.userId, provider2User.userId] }, title: 'Booking tomorrow' },
    });
    expect(notes).toBe(0); // unconfirmed → silent
  });
});
