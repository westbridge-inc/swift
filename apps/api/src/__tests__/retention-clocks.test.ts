import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { prismaPlugin } from '../plugins/prisma';
import { registerErrorHandler } from '../middleware/error-handler';
import {
  RETENTION_DEFAULTS, seedRetentionDefaults, runRetentionSweep,
} from '../modules/compliance/retention.service';

// [DCR-1 NR-2] Retention clocks: the registry declares each window as data,
// the sweep enforces it by the class's own timestamp, and every enforcement
// writes a receipt — rows younger than the window must be untouchable.
let app: FastifyInstance;
let userId: string;
const DAY = 24 * 60 * 60 * 1000;

function daysAgo(n: number): Date {
  return new Date(Date.now() - n * DAY);
}

beforeAll(async () => {
  process.env['NODE_ENV'] = 'development';
  process.env['DATABASE_URL'] = process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift';
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(prismaPlugin);
  await app.ready();
  const user = await app.prisma.user.create({
    data: {
      phone: `+59200RET${nanoid(6)}`, firstName: 'Clock', lastName: 'Subject',
      roles: ['CUSTOMER'], activeRole: 'CUSTOMER',
    },
    select: { id: true },
  });
  userId = user.id;
});

afterAll(async () => {
  await app.prisma.notification.deleteMany({ where: { userId } });
  await app.prisma.session.deleteMany({ where: { userId } });
  await app.prisma.user.delete({ where: { id: userId } }).catch(() => {});
  await app.close();
});

describe('retention clocks [DCR-1 NR-2]', () => {
  it('seeds conservative defaults idempotently and never overwrites tuned rows', async () => {
    await seedRetentionDefaults(app.prisma);
    const rows = await app.prisma.retentionPolicy.findMany();
    for (const d of RETENTION_DEFAULTS) {
      expect(rows.find((r) => r.dataClass === d.dataClass)?.retainDays).toBe(d.retainDays);
    }
    // Operator tunes a window → reseeding must not clobber it.
    await app.prisma.retentionPolicy.update({
      where: { dataClass: 'notifications.old' }, data: { retainDays: 123 },
    });
    await seedRetentionDefaults(app.prisma);
    const tuned = await app.prisma.retentionPolicy.findUniqueOrThrow({
      where: { dataClass: 'notifications.old' },
    });
    expect(tuned.retainDays).toBe(123);
    await app.prisma.retentionPolicy.update({
      where: { dataClass: 'notifications.old' }, data: { retainDays: 180 },
    });
  });

  it('deletes only rows past their window — younger rows are untouchable', async () => {
    const mkSession = (expiresAt: Date) => app.prisma.session.create({
      data: {
        userId, token: `ret-${nanoid(24)}`, refreshToken: nanoid(48),
        deviceId: 'nr2', deviceType: 'test', expiresAt,
      },
      select: { id: true },
    });
    const dead = await mkSession(daysAgo(45));       // expired 45d ago → due (window 30)
    const recent = await mkSession(daysAgo(5));      // expired 5d ago → keep
    const live = await mkSession(new Date(Date.now() + DAY)); // active → keep

    const oldNotif = await app.prisma.notification.create({
      data: { userId, type: 'SYSTEM_ANNOUNCEMENT', title: 'old', body: 'x', createdAt: daysAgo(200) },
      select: { id: true },
    });
    const newNotif = await app.prisma.notification.create({
      data: { userId, type: 'SYSTEM_ANNOUNCEMENT', title: 'new', body: 'x' },
      select: { id: true },
    });
    const oldAttempt = await app.prisma.signupAttempt.create({
      data: { phoneHash: `ret-${nanoid(8)}`, outcome: 'CREATED', createdAt: daysAgo(120) },
      select: { id: true },
    });

    const results = await runRetentionSweep(app.prisma);
    const byClass = Object.fromEntries(results.map((r) => [r.dataClass, r]));
    expect(byClass['sessions.expired']!.deleted).toBeGreaterThanOrEqual(1);
    expect(byClass['signup_attempts']!.deleted).toBeGreaterThanOrEqual(1);
    expect(byClass['notifications.old']!.deleted).toBeGreaterThanOrEqual(1);

    const ids = async () => ({
      dead: await app.prisma.session.findUnique({ where: { id: dead.id } }),
      recent: await app.prisma.session.findUnique({ where: { id: recent.id } }),
      live: await app.prisma.session.findUnique({ where: { id: live.id } }),
      oldNotif: await app.prisma.notification.findUnique({ where: { id: oldNotif.id } }),
      newNotif: await app.prisma.notification.findUnique({ where: { id: newNotif.id } }),
      oldAttempt: await app.prisma.signupAttempt.findUnique({ where: { id: oldAttempt.id } }),
    });
    const after = await ids();
    expect(after.dead).toBeNull();
    expect(after.oldNotif).toBeNull();
    expect(after.oldAttempt).toBeNull();
    expect(after.recent).not.toBeNull();
    expect(after.live).not.toBeNull();
    expect(after.newNotif).not.toBeNull();
  });

  it('writes a receipt per enforced policy — the demonstrable-compliance trail', async () => {
    const before = await app.prisma.retentionSweepReceipt.count();
    const results = await runRetentionSweep(app.prisma);
    const enforced = results.filter((r) => !r.skipped);
    expect(enforced.length).toBe(RETENTION_DEFAULTS.length);
    const afterCount = await app.prisma.retentionSweepReceipt.count();
    expect(afterCount - before).toBe(enforced.length);
    const latest = await app.prisma.retentionSweepReceipt.findFirstOrThrow({
      where: { dataClass: 'sessions.expired' }, orderBy: { ranAt: 'desc' },
    });
    expect(latest.cutoff.getTime()).toBeLessThan(Date.now());
  });

  it('a disabled policy is skipped and reported, never enforced', async () => {
    await app.prisma.retentionPolicy.update({
      where: { dataClass: 'signup_attempts' }, data: { enabled: false },
    });
    try {
      const survivor = await app.prisma.signupAttempt.create({
        data: { phoneHash: `ret-${nanoid(8)}`, outcome: 'CREATED', createdAt: daysAgo(400) },
        select: { id: true },
      });
      const results = await runRetentionSweep(app.prisma);
      expect(results.find((r) => r.dataClass === 'signup_attempts')?.skipped).toBe('disabled');
      expect(await app.prisma.signupAttempt.findUnique({ where: { id: survivor.id } })).not.toBeNull();
      await app.prisma.signupAttempt.delete({ where: { id: survivor.id } });
    } finally {
      await app.prisma.retentionPolicy.update({
        where: { dataClass: 'signup_attempts' }, data: { enabled: true },
      });
    }
  });

  it('a registry row without an enforcer is surfaced as a coverage gap, not silently ignored', async () => {
    const ghost = `ghost.${nanoid(6)}`;
    await app.prisma.retentionPolicy.create({
      data: { dataClass: ghost, description: 'x', retainDays: 1, legalBasis: 'x' },
    });
    try {
      const results = await runRetentionSweep(app.prisma);
      expect(results.find((r) => r.dataClass === ghost)?.skipped).toBe('no-enforcer');
    } finally {
      await app.prisma.retentionPolicy.delete({ where: { dataClass: ghost } });
    }
  });
});
