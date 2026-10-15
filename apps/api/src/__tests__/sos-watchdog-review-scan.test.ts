/**
 * [GUARDRAILS §3] The SOS watchdog pages operations for every ACTIVE alert
 * whose ops page is still undelivered past the threshold, and a store-review
 * (REVIEW tenant) alert never pages real operations. The scan reads the oldest
 * stuck alerts first, with a bound, so demo alerts must be dropped by the scan
 * itself: otherwise enough old demo alerts fill the bound, and a real SOS behind
 * them is never found, never paged and never counted.
 *
 * An alert with no tenant is never treated as a demo: when in doubt, the
 * watchdog pages.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { nanoid } from 'nanoid';
import { scanSosEscalations, ACTIVE_WITHOUT_PAGE_SECONDS } from '../modules/safety/sos-escalation';

const prisma = new PrismaClient({ datasources: { db: { url: process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift_test' } } });
const RUN = nanoid(8).replace(/[^a-zA-Z0-9]/g, '0');
const REVIEW = `sosw-${RUN}`;
// More than the scan's bound (100) and more than the watchdog's page cap (20).
const DEMO_ALERTS = 101;
const DEMO_PREFIX = `sosw-${RUN}-d`;
const REAL = `sosw-${RUN}-real`;
const TENANTLESS = `sosw-${RUN}-none`;
const userIds: string[] = [];
const alertIds: string[] = [];
let seq = 0;
const phone = () => `+${592_709_000_000 + Math.floor(Math.random() * 60_000_000) + (seq += 1)}`;

beforeAll(async () => {
  await prisma.tenant.create({ data: { id: REVIEW, name: 'SOS watchdog fiction', slug: REVIEW, kind: 'REVIEW' } });
  const demoUser = await prisma.user.create({ data: { phone: phone(), firstName: 'D', lastName: 'F', roles: ['CUSTOMER'], activeRole: 'CUSTOMER', tenantId: REVIEW, isSynthetic: true } });
  const realUser = await prisma.user.create({ data: { phone: phone(), firstName: 'R', lastName: 'P', roles: ['CUSTOMER'], activeRole: 'CUSTOMER' } });
  userIds.push(demoUser.id, realUser.id);
  const stuckSince = Date.now() - (ACTIVE_WITHOUT_PAGE_SECONDS + 3_600) * 1000;
  // Every demo alert is OLDER than the real ones, so oldest-first reaches them first.
  const demo = Array.from({ length: DEMO_ALERTS }, (_, i) => ({
    id: `${DEMO_PREFIX}${i}`, tenantId: REVIEW, actorUserId: demoUser.id,
    triggeredAt: new Date(stuckSince - (DEMO_ALERTS - i + 10) * 60_000),
  }));
  const real = [
    { id: REAL, tenantId: 'swift-default', actorUserId: realUser.id, triggeredAt: new Date(stuckSince) },
    { id: TENANTLESS, tenantId: null, actorUserId: realUser.id, triggeredAt: new Date(stuckSince - 60_000) },
  ];
  const alerts = [...demo, ...real];
  await prisma.sosAlert.createMany({ data: alerts.map((a) => ({ ...a, actorRole: 'CUSTOMER', status: 'ACTIVE' as const, triggerSource: 'BUTTON' as const })) });
  alertIds.push(...alerts.map((a) => a.id));
  // Each alert's ops page never went out.
  await prisma.sosEscalation.createMany({ data: alerts.map((a) => ({
    tenantId: a.tenantId, sosAlertId: a.id, channel: 'OPS_PAGE' as const, targetKey: 'ops', status: 'FAILED' as const, attempts: 20,
  })) });
});

afterAll(async () => {
  await prisma.sosAlert.deleteMany({ where: { id: { in: alertIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await prisma.tenant.delete({ where: { id: REVIEW } }).catch(() => {});
  await prisma.$disconnect();
});

describe('the SOS watchdog scan never lets demo alerts hide a real one', () => {
  it('a real stuck SOS behind 101 older demo alerts is found, and no demo alert is returned', async () => {
    const ids = (await scanSosEscalations(prisma)).activeWithoutPage.map((s) => s.sosAlertId);
    expect(ids).toContain(REAL);
    expect(ids.filter((id) => id.startsWith(DEMO_PREFIX))).toEqual([]);
  });

  it('an alert with no tenant is still treated as real', async () => {
    const ids = (await scanSosEscalations(prisma)).activeWithoutPage.map((s) => s.sosAlertId);
    expect(ids).toContain(TENANTLESS);
  });
});
