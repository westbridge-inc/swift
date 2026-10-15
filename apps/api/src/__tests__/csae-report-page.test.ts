import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import type { UserRole } from '@prisma/client';
import { prismaPlugin, runWithoutTenant } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { moderationRoutes } from '../modules/moderation/moderation.routes';
import { registerErrorHandler } from '../middleware/error-handler';
import { CSAE_PAGE_TITLE } from '../modules/moderation/csae-page';

// ---------------------------------------------------------------------------
// [Brief item 3 · Child Safety Standards] "Reports reach our moderation team immediately and are
// prioritised." A report filed with the reason Child safety (CSAE) sat in the moderation queue until
// someone looked; nothing paged anyone. It now opens an ops page (the SOS outbox: an acknowledgement
// deadline, escalation, on-call texts) addressed to the operators, naming the report and nothing else.
// Other reasons page nobody; reporting the same thing twice pages once.
// ---------------------------------------------------------------------------

let app: FastifyInstance;
const RUN = nanoid(6);
const userIds: string[] = [];
let reporter = { id: '', token: '' };
let adminId = '';
const since = new Date();

async function mkUser(roles: UserRole[], activeRole: UserRole) {
  const u = await app.prisma.user.create({
    data: { phone: `+59200${String(Math.floor(Math.random() * 90000) + 10000)}`, firstName: 'Csae', lastName: `Page${RUN}`, roles, activeRole, isPhoneVerified: true, ...(activeRole === 'ADMIN' ? { admin: { create: { permissions: ['*'] } } } : {}) },
  });
  userIds.push(u.id);
  const token = app.jwt.sign({ userId: u.id, role: activeRole, jti: nanoid(8) });
  await app.prisma.session.create({ data: { authMethod: 'OTP', userId: u.id, token, refreshToken: nanoid(48), deviceId: 'csae', deviceType: 'test', expiresAt: new Date(Date.now() + 86_400_000) } });
  return { id: u.id, token };
}

const report = (body: Record<string, unknown>) =>
  app.inject({ method: 'POST', url: '/api/v1/reports', headers: { 'content-type': 'application/json', authorization: `Bearer ${reporter.token}` }, payload: body });

/** Close (never delete) this run's pages at once: an open page would be swept and texted by any other suite that
 *  runs the escalation sweep at the same time (safety-ops-alert-ack counts its on-call texts). */
const closeOurPages = () => runWithoutTenant(() => app.prisma.opsAlert.updateMany({
  where: { title: CSAE_PAGE_TITLE, createdAt: { gte: since }, closedAt: null }, data: { closedAt: new Date(), closeReason: 'test-cleanup' },
}), 'test-cleanup:csae-page');

const csaePages = () => runWithoutTenant(() => app.prisma.opsAlert.findMany({
  where: { title: CSAE_PAGE_TITLE, createdAt: { gte: since } },
  include: { recipients: { select: { userId: true, notificationId: true } } },
}), 'test-read:csae-page');

beforeAll(async () => {
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  await app.register(moderationRoutes, { prefix: '/api/v1' });
  await app.ready();
  reporter = await mkUser(['CUSTOMER'] as UserRole[], 'CUSTOMER' as UserRole);
  await app.redis.del(`csae:page:${reporter.id}`);
  adminId = (await mkUser(['ADMIN'] as UserRole[], 'ADMIN' as UserRole)).id;
});

afterAll(async () => {
  await runWithoutTenant(async () => {
    const pages = await app.prisma.opsAlert.findMany({ where: { title: CSAE_PAGE_TITLE, createdAt: { gte: since } }, select: { id: true } });
    // Close (never delete) what this run opened, so the escalation sweep of a shared DB does not chase it.
    await app.prisma.opsAlert.updateMany({ where: { id: { in: pages.map((p) => p.id) } }, data: { closedAt: new Date(), closeReason: 'test-cleanup' } });
    await app.prisma.contentReport.deleteMany({ where: { reporterId: { in: userIds } } });
    await app.prisma.session.deleteMany({ where: { userId: { in: userIds } } });
  }, 'test-cleanup:csae-page');
  await app.close();
});

describe('a Child safety (CSAE) report pages operations at once', () => {
  it('a CSAE report opens one ops page addressed to the operators, naming the report and no person', async () => {
    const target = `user_${RUN}_a`;
    const res = await report({ targetType: 'USER', targetId: target, reason: 'CSAE' });
    await closeOurPages();
    expect(res.statusCode, res.body).toBe(201);
    const reportId = res.json().data.id as string;

    const pages = await csaePages();
    expect(pages).toHaveLength(1);
    const page = pages[0]!;
    expect(page.kind).toBe('PLATFORM');
    expect(page.acknowledgedAt).toBeNull();
    expect(page.recipients.map((r) => r.userId)).toContain(adminId);
    expect(page.body).not.toContain(target);
    expect(page.body).not.toMatch(/Csae|Page/);

    const note = await runWithoutTenant(() => app.prisma.notification.findFirst({ where: { userId: adminId, title: CSAE_PAGE_TITLE } }), 'test-read:csae-page');
    expect(note?.data).toMatchObject({ kind: 'csae_report', contentReportId: reportId, targetType: 'USER', opsAlertId: page.id });
  });

  it('reporting the same thing again pages nobody new (the report is already on record)', async () => {
    const again = await report({ targetType: 'USER', targetId: `user_${RUN}_a`, reason: 'CSAE' });
    await closeOurPages();
    expect(again.statusCode).toBe(200);
    expect(again.json().alreadyReported).toBe(true);
    expect(await csaePages()).toHaveLength(1);
  });

  it('[REVIEW-F S3-1] a second CSAE report by the same person within 10 minutes is recorded but pages nobody new', async () => {
    const res = await report({ targetType: 'USER', targetId: `user_${RUN}_b`, reason: 'CSAE' });
    await closeOurPages();
    expect(res.statusCode, res.body).toBe(201);
    expect(await csaePages()).toHaveLength(1);
  });

  it.each(['SPAM', 'HARASSMENT', 'SEXUAL_CONTENT', 'OTHER'])('a %s report pages nobody', async (reason) => {
    const res = await report({ targetType: 'USER', targetId: `user_${RUN}_${reason}`, reason });
    expect(res.statusCode, res.body).toBe(201);
    expect(await csaePages()).toHaveLength(1);
  });
});
