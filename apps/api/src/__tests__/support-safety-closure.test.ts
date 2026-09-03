import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { registerErrorHandler } from '../middleware/error-handler';
import { registerEmptyJsonBodyParser } from '../plugins/empty-json';
import { adminRoutes } from '../modules/admin/admin.routes';
import { authRoutes } from '../modules/auth/auth.routes';
import { loginWithOtp } from './helpers/otp';
import { SAFETY_NOTE_MIN, SAFETY_RESOLUTIONS } from '../modules/support/support.service';

// ---------------------------------------------------------------------------
// [A-18] A SAFETY TICKET CANNOT BE CLOSED SILENTLY.
//
// The console closed a ticket from a single window.prompt whose CANCEL still
// fired the mutation: `window.prompt(...) ?? undefined` then resolve, always.
// A mis-click closed an urgent report with no note, no disposition and no
// record of anyone having looked at it, and the reporter got a generic "we've
// resolved your issue" push.
//
// The server now refuses to close a ticket that does not say what happened; a
// SAFETY ticket must close on what was DONE — never on "answered" — and must
// carry a note the reporter will read. A ticket someone else already moved
// cannot be re-decided from a stale screen.
// ---------------------------------------------------------------------------

let app: FastifyInstance;
let adminToken: string;
const userIds: string[] = [];
const ticketIds: string[] = [];
let reporterId: string;
let seq = 0;
const phoneBase = 592_613_000_000 + Math.floor(Math.random() * 800_000_000);

async function makeUser(roles: string[], activeRole: string) {
  seq += 1;
  const user = await app.prisma.user.create({
    data: {
      phone: `+${phoneBase + seq}`,
      firstName: 'Support',
      lastName: `U${seq}`,
      roles: roles as never,
      activeRole: activeRole as never,
      isPhoneVerified: true,
    },
  });
  userIds.push(user.id);
  return user;
}

async function makeTicket(category: 'SAFETY' | 'ORDER_ISSUE', status: 'OPEN' | 'IN_PROGRESS' = 'OPEN') {
  const ticket = await app.prisma.supportTicket.create({
    data: {
      userId: reporterId,
      category,
      subject: `${category} ${nanoid(6)}`,
      message: category === 'SAFETY' ? 'The driver was following me after the trip ended.' : 'My order arrived cold.',
      status,
    },
  });
  ticketIds.push(ticket.id);
  return ticket;
}

const resolve = (id: string, payload: Record<string, unknown>) =>
  app.inject({
    method: 'PUT',
    url: `/api/v1/admin/support/${id}/resolve`,
    headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
    payload,
  });

beforeAll(async () => {
  const server = Fastify({ logger: false });
  registerErrorHandler(server);
  registerEmptyJsonBodyParser(server);
  await server.register(prismaPlugin);
  await server.register(redisPlugin);
  await server.register(authPlugin);
  await server.register(socketPlugin);
  await server.register(authRoutes, { prefix: '/api/v1/auth' });
  await server.register(adminRoutes, { prefix: '/api/v1/admin' });
  await server.ready();
  app = server;

  const login = await loginWithOtp(app, '+5926001000'); // seeded SUPER_ADMIN
  adminToken = login.json().data.tokens.accessToken;
  const reporter = await makeUser(['CUSTOMER'], 'CUSTOMER');
  reporterId = reporter.id;
});

afterAll(async () => {
  await app.prisma.notification.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.supportTicket.deleteMany({ where: { id: { in: ticketIds } } });
  await app.prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await app.close();
});

describe('[A-18] a close says what happened', () => {
  it('a resolve with no disposition is refused — the ticket stays open and the reporter is told nothing', async () => {
    const ticket = await makeTicket('ORDER_ISSUE');
    const res = await resolve(ticket.id, { status: 'RESOLVED' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('RESOLUTION_REQUIRED');

    const after = await app.prisma.supportTicket.findUniqueOrThrow({ where: { id: ticket.id } });
    expect(after.status).toBe('OPEN');
    expect(after.resolvedAt).toBeNull();
    const told = await app.prisma.notification.count({ where: { userId: reporterId, data: { path: ['ticketId'], equals: ticket.id } } });
    expect(told).toBe(0);
  });

  it('an ordinary ticket closes with a disposition, which is recorded', async () => {
    const ticket = await makeTicket('ORDER_ISSUE');
    const res = await resolve(ticket.id, { status: 'RESOLVED', resolution: 'ANSWERED', adminNote: 'Refund issued for the cold order.' });
    expect(res.statusCode).toBe(200);
    const after = await app.prisma.supportTicket.findUniqueOrThrow({ where: { id: ticket.id } });
    expect(after.status).toBe('RESOLVED');
    expect(after.resolution).toBe('ANSWERED');
    expect(after.resolvedAt).not.toBeNull();
    expect(after.resolvedById).not.toBeNull();
  });
});

describe('[A-18] a safety report closes on what was done', () => {
  it('“answered” is refused on a SAFETY ticket, and the ticket stays open', async () => {
    const ticket = await makeTicket('SAFETY');
    const res = await resolve(ticket.id, { status: 'RESOLVED', resolution: 'ANSWERED', adminNote: 'We replied to the customer about this.' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('SAFETY_RESOLUTION_REQUIRED');
    const after = await app.prisma.supportTicket.findUniqueOrThrow({ where: { id: ticket.id } });
    expect(after.status).toBe('OPEN');
    expect(after.resolution).toBeNull();
  });

  it('a safety close without a note the reporter can read is refused', async () => {
    const ticket = await makeTicket('SAFETY');
    const res = await resolve(ticket.id, { status: 'RESOLVED', resolution: 'ACTION_TAKEN', adminNote: 'ok' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('SAFETY_NOTE_REQUIRED');
    expect(res.json().error.message).toContain(String(SAFETY_NOTE_MIN));

    const none = await resolve(ticket.id, { status: 'RESOLVED', resolution: 'ACTION_TAKEN' });
    expect(none.statusCode).toBe(400);
    expect(none.json().error.code).toBe('SAFETY_NOTE_REQUIRED');

    const after = await app.prisma.supportTicket.findUniqueOrThrow({ where: { id: ticket.id } });
    expect(after.status).toBe('OPEN');
  });

  it.each(SAFETY_RESOLUTIONS)('a safety close on %s with a real note succeeds and is recorded', async (resolution) => {
    const ticket = await makeTicket('SAFETY');
    const note = 'The driver account is suspended while the safety team reviews the trip.';
    const res = await resolve(ticket.id, { status: 'RESOLVED', resolution, adminNote: note });
    expect(res.statusCode).toBe(200);
    const after = await app.prisma.supportTicket.findUniqueOrThrow({ where: { id: ticket.id } });
    expect(after.resolution).toBe(resolution);
    expect(after.adminNote).toBe(note);
    expect(after.resolvedById).not.toBeNull();
  });
});

describe('[A-18] a ticket is not decided twice, or from a stale screen', () => {
  it('resolving an already-resolved ticket is refused, not a silent second close', async () => {
    const ticket = await makeTicket('ORDER_ISSUE');
    expect((await resolve(ticket.id, { status: 'RESOLVED', resolution: 'ANSWERED' })).statusCode).toBe(200);
    const again = await resolve(ticket.id, { status: 'RESOLVED', resolution: 'ACTION_TAKEN', adminNote: 'second look' });
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe('ALREADY_RESOLVED');
    const after = await app.prisma.supportTicket.findUniqueOrThrow({ where: { id: ticket.id } });
    expect(after.resolution).toBe('ANSWERED');
  });

  it('a screen that believed the ticket was OPEN cannot close one someone else has taken', async () => {
    const ticket = await makeTicket('ORDER_ISSUE', 'IN_PROGRESS');
    const stale = await resolve(ticket.id, { status: 'RESOLVED', resolution: 'ANSWERED', expectedStatus: 'OPEN' });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.code).toBe('TICKET_MOVED');

    const fresh = await resolve(ticket.id, { status: 'RESOLVED', resolution: 'ANSWERED', expectedStatus: 'IN_PROGRESS' });
    expect(fresh.statusCode).toBe(200);
  });

  it('taking a ticket is not a close: no disposition needed, and it does not resolve', async () => {
    const ticket = await makeTicket('SAFETY');
    const res = await resolve(ticket.id, { status: 'IN_PROGRESS', expectedStatus: 'OPEN' });
    expect(res.statusCode).toBe(200);
    const after = await app.prisma.supportTicket.findUniqueOrThrow({ where: { id: ticket.id } });
    expect(after.status).toBe('IN_PROGRESS');
    expect(after.resolution).toBeNull();
    expect(after.resolvedAt).toBeNull();
  });
});
