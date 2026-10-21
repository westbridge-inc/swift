/**
 * [Off-site erasure ledger · COORD ruling 21 Oct] An erasure that has not reached the off-site ledger
 * within 10 minutes is an incident: the host unit has stopped, and a total loss of the live database now
 * would bring that person back. Real database; entries are inserted directly (the test login owns them).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { socketPlugin } from '../plugins/socket';
import { runWithoutTenant } from '../plugins/tenant-context';
import { NotificationService } from '../modules/notification/notification.service';
import {
  checkErasureLedgerShipping, ERASURE_LEDGER_MAX_UNSHIPPED_MINUTES, ERASURE_LEDGER_PAGE_KEY, ERASURE_LEDGER_PAGE_TITLE, pageErasureLedgerShipping,
} from '../modules/ops/erasure-ledger-watch';

let app: FastifyInstance;
const sys = <T>(fn: () => Promise<T>) => runWithoutTenant(fn, 'erasure-ledger-watch-test');
const shipEverything = () => sys(() => app.prisma.$executeRawUnsafe(
  `INSERT INTO erasure_ledger_shipment ("entryId", "objectKey") SELECT e.id, 'test/shipped-before-this-test' FROM erasure_ledger_entry e
   WHERE NOT EXISTS (SELECT 1 FROM erasure_ledger_shipment s WHERE s."entryId" = e.id)`));
const entryAged = async (minutes: number) => (await sys(() => app.prisma.$queryRawUnsafe<Array<{ id: string }>>(
  `INSERT INTO erasure_ledger_entry (kind, entry, "createdAt") VALUES ('deleted_rows', '{"tbl":"synthetic","id":"synthetic"}', now()::timestamp(3) - make_interval(mins => $1::int)) RETURNING id`, minutes)))[0]!.id;
const ship = (id: string) => sys(() => app.prisma.$executeRawUnsafe(`INSERT INTO erasure_ledger_shipment ("entryId", "objectKey") VALUES ($1::uuid, 'test/synthetic')`, id));

beforeAll(async () => {
  app = Fastify({ logger: false });
  await app.register(prismaPlugin); await app.register(redisPlugin); await app.register(socketPlugin);
  await app.ready();
  await shipEverything();
  await app.redis.del(ERASURE_LEDGER_PAGE_KEY).catch(() => {});
});

afterAll(async () => {
  await sys(async () => {
    const rows = await app.prisma.opsAlert.findMany({ where: { title: ERASURE_LEDGER_PAGE_TITLE }, select: { id: true } });
    await app.prisma.opsAlertRecipient.deleteMany({ where: { opsAlertId: { in: rows.map((r) => r.id) } } }).catch(() => {});
    await app.prisma.opsAlert.deleteMany({ where: { id: { in: rows.map((r) => r.id) } } }).catch(() => {});
  });
  await shipEverything();
  await app.redis.del(ERASURE_LEDGER_PAGE_KEY).catch(() => {});
  await app.close();
});

describe('an erasure that never reaches the off-site ledger is an incident', () => {
  it('the window is 10 minutes', () => { expect(ERASURE_LEDGER_MAX_UNSHIPPED_MINUTES).toBe(10); });

  it('everything shipped: calm', async () => {
    expect((await sys(() => checkErasureLedgerShipping(app.prisma))).stale).toBe(false);
  });

  it('an entry younger than the window is still in flight; an older one is stale, counted, never named', async () => {
    const young = await entryAged(5);
    expect((await sys(() => checkErasureLedgerShipping(app.prisma))).stale).toBe(false);
    const old = await entryAged(11);
    const r = await sys(() => checkErasureLedgerShipping(app.prisma));
    expect(r.stale).toBe(true);
    expect(r.unshipped).toBe(1);
    expect(r.oldestMinutes).toBeGreaterThanOrEqual(10);
    expect(r.reason).toMatch(/not reached the off-site/);
    expect(r.reason).not.toContain(old);
    await ship(old); await ship(young);
    expect((await sys(() => checkErasureLedgerShipping(app.prisma))).stale).toBe(false);
  });

  it('a stale ledger pages the platform responders; a shipped one closes the page', async () => {
    const deps = { prisma: app.prisma, redis: app.redis, notifications: new NotificationService(app.prisma, app.io) };
    const old = await entryAged(15);
    const stale = await sys(() => pageErasureLedgerShipping(deps));
    expect(stale.result.stale).toBe(true);
    expect(stale.page).not.toBeNull();
    const open = await sys(() => app.prisma.opsAlert.findMany({ where: { title: ERASURE_LEDGER_PAGE_TITLE } }));
    expect(open.length).toBeGreaterThan(0);
    await ship(old);
    const calm = await sys(() => pageErasureLedgerShipping(deps));
    expect(calm.result.stale).toBe(false);
    expect(calm.page).toBeNull();
  });
});
