import { afterAll, describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { OrderStatus, PrismaClient, type Prisma } from '@prisma/client';
import { ORDER_TRANSITIONS, RECOVERY_TRANSITIONS } from '../modules/order/order-status';
import { testPrismaClient } from './helpers/test-prisma-client';
import {
  ORDER_STATUS_GUARD,
  ORDER_STATUS_LOG_GUARD,
  orderStatusGuardBody,
  orderStatusGuardDdl,
  orderStatusLogGuardBody,
} from '../modules/order/order-status-guard';

// ---------------------------------------------------------------------------
// [row 264 · AUD-L3a-003 / AUD-L7-005] The database refuses an illegal
// order-status change, and order_status_logs is append-only in the database.
//
// order-state-machine-integrity.test.ts checks the TABLE in memory. Nothing
// ever wrote an illegal status to a real row, so nothing could notice that
// the database accepted every one of them. This suite writes every ordered
// pair of statuses to a real row, directly in SQL (no seam, no Prisma
// extension), and requires the database to accept exactly the edges declared
// in order-status.ts and refuse every other change. The expected set is read
// from ORDER_TRANSITIONS and RECOVERY_TRANSITIONS HERE, not from the
// generator, so a generator that drops or invents an edge is caught too, and
// an edge added to order-status.ts without a migration that regenerates the
// trigger fails this suite.
//
// Fixtures live in ONE transaction that is rolled back; each probe runs in its
// own savepoint that is always rolled back, so every probe starts from its
// fixture status and nothing is left behind. The race case commits (two
// connections) and cleans up after itself.
// ---------------------------------------------------------------------------

// testPrismaClient() refuses any database that is not a disposable test one (AUD-G7-040 ratchet).
const db = testPrismaClient();
const RUN = randomUUID().replace(/-/g, '').slice(0, 10);
const PHONE = `+592264${String(Number.parseInt(RUN.slice(0, 6), 16) % 100000).padStart(5, '0')}`;
const STATUSES = Object.values(OrderStatus) as OrderStatus[];
const MIGRATIONS = path.resolve(__dirname, '../../prisma/migrations');
const NAME = '20261015051000_order_status_transition_guard';
/** The newest migration on main when this was written (15 Oct 04:30Z). */
const NEWEST_ON_MAIN_AT_WRITE = '20261015010000_mmg_fee_reversals';
const normalise = (sql: string) => sql.replace(/\s+/g, ' ').trim();
class Rollback extends Error {}

/** Every declared edge, read straight from the two tables (not from the generator). */
const DECLARED = new Set<string>();
for (const table of [ORDER_TRANSITIONS, RECOVERY_TRANSITIONS]) {
  for (const to of Object.keys(table) as OrderStatus[]) for (const from of table[to]) DECLARED.add(`${from}>${to}`);
}

const cleanup: { orders: string[]; users: string[] } = { orders: [], users: [] };

afterAll(async () => {
  // Deleting the order is the one way its status-log rows may leave (the cascade).
  if (cleanup.orders.length) await db.order.deleteMany({ where: { id: { in: cleanup.orders } } });
  if (cleanup.users.length) await db.user.deleteMany({ where: { id: { in: cleanup.users } } });
  await db.$disconnect();
});

/** Run a fixture and its checks, then undo everything. */
async function rolledBack(fn: (tx: Prisma.TransactionClient) => Promise<void>) {
  await expect(db.$transaction(async (tx) => {
    await fn(tx);
    throw new Rollback('fixture rolled back');
  }, { timeout: 120_000 })).rejects.toBeInstanceOf(Rollback);
}

/** The database's answer to one write, which is always undone: null when accepted, else its refusal. */
async function probe(tx: Prisma.TransactionClient, write: () => Promise<unknown>): Promise<string | null> {
  const savepoint = `probe_${randomUUID().replace(/-/g, '')}`;
  await tx.$executeRawUnsafe(`SAVEPOINT ${savepoint}`);
  try {
    await write();
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  } finally {
    await tx.$executeRawUnsafe(`ROLLBACK TO SAVEPOINT ${savepoint}`);
  }
}

async function customer(client: Prisma.TransactionClient | PrismaClient, n: number): Promise<string> {
  const user = await client.user.create({
    data: { phone: `${PHONE}${n}`, firstName: 'Status', lastName: 'Guard', activeRole: 'CUSTOMER' },
  });
  return user.id;
}

async function order(client: Prisma.TransactionClient | PrismaClient, customerId: string, status: OrderStatus, tag: string): Promise<string> {
  const row = await client.order.create({
    data: {
      orderNumber: `R264-${RUN}-${tag}`,
      orderType: 'COURIER',
      customerId,
      status,
      deliveryAddress: 'x', deliveryLat: 6.8, deliveryLng: -58.15,
      subtotalBase: 0, subtotalMarkup: 0, subtotalCustomer: 0, deliveryFee: 800, totalAmount: 800,
      paymentMethod: 'CASH',
    },
  });
  return row.id;
}

const setStatus = (tx: Prisma.TransactionClient, id: string, to: OrderStatus) =>
  tx.$executeRawUnsafe(`UPDATE "orders" SET "status" = $1::"OrderStatus" WHERE "id" = $2`, to, id);

describe('the database holds the order machine (row 264)', () => {
  it('accepts exactly the declared edges and refuses every other status change, written directly in SQL', async () => {
    // A machine with no edges would make the matrix vacuous.
    expect(DECLARED.size).toBeGreaterThan(40);
    const unexpected: string[] = [];
    let accepted = 0;
    let refused = 0;
    await rolledBack(async (tx) => {
      const who = await customer(tx, 1);
      for (const from of STATUSES) {
        const id = await order(tx, who, from, `m-${from}`);
        for (const to of STATUSES) {
          if (to === from) continue;
          const answer = await probe(tx, () => setStatus(tx, id, to));
          const declared = DECLARED.has(`${from}>${to}`);
          if (answer === null) accepted += 1; else refused += 1;
          if (declared && answer !== null) unexpected.push(`${from} -> ${to} is declared but REFUSED: ${answer.slice(0, 160)}`);
          if (!declared && answer === null) unexpected.push(`${from} -> ${to} is NOT declared but was ACCEPTED`);
          if (!declared && answer !== null && !/ORDER_STATUS_ILLEGAL/.test(answer)) unexpected.push(`${from} -> ${to} refused for another reason: ${answer.slice(0, 160)}`);
        }
      }
    });
    expect(unexpected).toEqual([]);
    expect(accepted).toBe(DECLARED.size);
    expect(accepted + refused).toBe(STATUSES.length * (STATUSES.length - 1));
  });

  it('the refusal reaches a Prisma caller that skips the seam, and leaves the row as it was', async () => {
    await rolledBack(async (tx) => {
      const id = await order(tx, await customer(tx, 2), 'PENDING', 'prisma');
      const answer = await probe(tx, () => tx.order.update({ where: { id }, data: { status: 'DELIVERED' } }));
      expect(answer).toMatch(/ORDER_STATUS_ILLEGAL: order \S+ cannot move from PENDING to DELIVERED/);
      expect((await tx.order.findUniqueOrThrow({ where: { id } })).status).toBe('PENDING');
      // A status-less write, a same-status write and a write to a terminal order's other columns are not judged.
      const cancelled = await order(tx, await customer(tx, 3), 'CANCELLED', 'quiet');
      expect(await probe(tx, () => tx.order.update({ where: { id: cancelled }, data: { status: 'CANCELLED', cancellationReason: 'kept' } }))).toBeNull();
      expect(await probe(tx, () => tx.order.update({ where: { id: cancelled }, data: { deliveryInstructions: 'note' } }))).toBeNull();
      // updateMany is refused as a whole: one illegal row stops the statement.
      const legal = await order(tx, await customer(tx, 4), 'PENDING', 'many-a');
      const illegal = await order(tx, await customer(tx, 5), 'COMPLETED', 'many-b');
      const many = await probe(tx, () => tx.order.updateMany({ where: { id: { in: [legal, illegal] } }, data: { status: 'ACCEPTED' } }));
      expect(many).toMatch(/ORDER_STATUS_ILLEGAL[\s\S]*COMPLETED to ACCEPTED/);
    });
  });

  it('two writers race on one row: the blind writer is judged on the status the first one committed', async () => {
    const who = await customer(db, 6);
    cleanup.users.push(who);
    const id = await order(db, who, 'PENDING', 'race');
    cleanup.orders.push(id);
    const marker = `race_${randomUUID().replace(/-/g, '')}`;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let firstWrote!: () => void;
    const wrote = new Promise<void>((resolve) => { firstWrote = resolve; });
    // Writer 1 accepts the order (PENDING -> ACCEPTED) and holds the row lock.
    const first = db.$transaction(async (tx) => {
      await setStatus(tx, id, 'ACCEPTED');
      firstWrote();
      await gate;
    }, { timeout: 30_000 });
    await wrote;
    // Writer 2 read PENDING earlier and blindly assigns a driver (PENDING -> DRIVER_ASSIGNED is legal from PENDING).
    const second = db.$executeRawUnsafe(`/* ${marker} */ UPDATE "orders" SET "status" = 'DRIVER_ASSIGNED' WHERE "id" = $1`, id)
      .then(() => null, (error: unknown) => (error instanceof Error ? error.message : String(error)));
    // Wait until writer 2 is queued behind writer 1's row lock, then let writer 1 commit.
    const deadline = Date.now() + 10_000;
    for (;;) {
      const rows = await db.$queryRawUnsafe<Array<{ waiting: bigint }>>(
        `SELECT count(*) AS waiting FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND position($1 in query) > 0`, marker,
      );
      if (Number(rows[0]?.waiting ?? 0) > 0) break;
      if (Date.now() > deadline) throw new Error('writer 2 never queued behind the row lock');
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    release();
    await first;
    expect(await second).toMatch(/ORDER_STATUS_ILLEGAL[\s\S]*ACCEPTED to DRIVER_ASSIGNED/);
    expect((await db.order.findUniqueOrThrow({ where: { id } })).status).toBe('ACCEPTED');
  });
});

describe('order_status_logs is append-only in the database (row 264)', () => {
  it('refuses UPDATE and DELETE from any connection, including a Prisma client without the append-only extension', async () => {
    await rolledBack(async (tx) => {
      const id = await order(tx, await customer(tx, 7), 'PENDING', 'log');
      const log = await tx.orderStatusLog.create({ data: { orderId: id, status: 'PENDING', note: 'placed' } });
      const update = await probe(tx, () => tx.$executeRawUnsafe(`UPDATE "order_status_logs" SET "note" = 'tampered' WHERE "id" = $1`, log.id));
      expect(update).toMatch(/ORDER_STATUS_LOG_APPEND_ONLY[\s\S]*UPDATE is refused/);
      const del = await probe(tx, () => tx.$executeRawUnsafe(`DELETE FROM "order_status_logs" WHERE "id" = $1`, log.id));
      expect(del).toMatch(/ORDER_STATUS_LOG_APPEND_ONLY[\s\S]*DELETE is refused/);
      expect(await probe(tx, () => tx.orderStatusLog.updateMany({ where: { orderId: id }, data: { note: 'tampered' } }))).toMatch(/ORDER_STATUS_LOG_APPEND_ONLY/);
      expect(await probe(tx, () => tx.orderStatusLog.deleteMany({ where: { orderId: id } }))).toMatch(/ORDER_STATUS_LOG_APPEND_ONLY/);
      expect((await tx.orderStatusLog.findUniqueOrThrow({ where: { id: log.id } })).note).toBe('placed');
      // Appending stays open.
      expect(await probe(tx, () => tx.orderStatusLog.create({ data: { orderId: id, status: 'PENDING', note: 'second line' } }))).toBeNull();
    });
  });

  it('a log row leaves with its order: deleting the order cascades its trail away', async () => {
    await rolledBack(async (tx) => {
      const id = await order(tx, await customer(tx, 8), 'PENDING', 'cascade');
      await tx.orderStatusLog.create({ data: { orderId: id, status: 'PENDING', note: 'placed' } });
      await tx.orderStatusLog.create({ data: { orderId: id, status: 'PENDING', note: 'nudged' } });
      expect(await probe(tx, async () => {
        await tx.order.delete({ where: { id } });
        expect(await tx.orderStatusLog.count({ where: { orderId: id } })).toBe(0);
      })).toBeNull();
    });
  });
});

describe('the guard is generated from order-status.ts and shipped by one migration (row 264)', () => {
  it('the live trigger functions are exactly the generated text', async () => {
    const rows = await db.$queryRawUnsafe<Array<{ proname: string; prosrc: string }>>(
      `SELECT proname, prosrc FROM pg_proc WHERE proname IN ($1, $2)`, ORDER_STATUS_GUARD, ORDER_STATUS_LOG_GUARD,
    );
    const live = Object.fromEntries(rows.map((r) => [r.proname, normalise(r.prosrc)]));
    expect(live[ORDER_STATUS_GUARD]).toBe(normalise(orderStatusGuardBody()));
    expect(live[ORDER_STATUS_LOG_GUARD]).toBe(normalise(orderStatusLogGuardBody()));
    const triggers = await db.$queryRawUnsafe<Array<{ tgname: string; tgenabled: string; def: string }>>(
      `SELECT tgname, tgenabled, pg_get_triggerdef(oid) AS def FROM pg_trigger WHERE tgname IN ($1, $2) AND NOT tgisinternal`, ORDER_STATUS_GUARD, ORDER_STATUS_LOG_GUARD,
    );
    expect(triggers.map((t) => [t.tgname, t.tgenabled]).sort()).toEqual([[ORDER_STATUS_LOG_GUARD, 'O'], [ORDER_STATUS_GUARD, 'O']]);
    const def = Object.fromEntries(triggers.map((t) => [t.tgname, t.def]));
    expect(def[ORDER_STATUS_GUARD]).toMatch(/BEFORE UPDATE ON (public\.)?orders FOR EACH ROW WHEN \(\(old\.status IS DISTINCT FROM new\.status\)\)/);
    expect(def[ORDER_STATUS_LOG_GUARD]).toMatch(/BEFORE DELETE OR UPDATE ON (public\.)?order_status_logs FOR EACH ROW/);
  });

  it('the newest migration that defines the guard carries the generated DDL, statement for statement', () => {
    const defining = readdirSync(MIGRATIONS).sort().filter((dir) => {
      const file = path.join(MIGRATIONS, dir, 'migration.sql');
      return existsSync(file) && readFileSync(file, 'utf8').includes(`FUNCTION ${ORDER_STATUS_GUARD}()`);
    });
    expect(defining[0]).toBe(NAME);
    const newest = defining[defining.length - 1] ?? NAME;
    const sql = normalise(readFileSync(path.join(MIGRATIONS, newest, 'migration.sql'), 'utf8'));
    for (const statement of orderStatusGuardDdl()) expect(sql).toContain(normalise(statement));
  });

  it('ships once, sorted after every migration it was written against, with a rollback that undoes exactly what it made', () => {
    expect(readdirSync(MIGRATIONS).filter((d) => d.endsWith('_order_status_transition_guard'))).toEqual([NAME]);
    expect(readdirSync(MIGRATIONS)).toContain(NEWEST_ON_MAIN_AT_WRITE);
    expect(NAME > NEWEST_ON_MAIN_AT_WRITE).toBe(true);
    const migration = readFileSync(path.join(MIGRATIONS, NAME, 'migration.sql'), 'utf8');
    const rollback = readFileSync(path.join(MIGRATIONS, NAME, 'rollback.sql'), 'utf8');
    const made = (re: RegExp, text: string) => [...text.matchAll(re)].map((m) => m[1]).sort();
    expect(made(/DROP FUNCTION IF EXISTS (\w+)\(/g, rollback)).toEqual(made(/CREATE OR REPLACE FUNCTION (\w+)\(/g, migration));
    expect(made(/DROP TRIGGER IF EXISTS (\w+) ON/g, rollback)).toEqual(made(/CREATE TRIGGER (\w+) /g, migration));
    expect(rollback).not.toMatch(/DROP (TABLE|COLUMN|TYPE|INDEX)|ALTER TABLE|UPDATE |DELETE FROM "(?!_prisma_migrations)/);
    expect(rollback).toContain(`DELETE FROM "_prisma_migrations" WHERE "migration_name" = '${NAME}';`);
    expect(rollback).toMatch(/^BEGIN;[\s\S]*COMMIT;\s*$/m);
  });
});
