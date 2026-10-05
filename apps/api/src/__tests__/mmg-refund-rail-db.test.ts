/**
 * [E02 · refund rail 1/8] The MMG refund rail's database laws, on real PostgreSQL.
 *
 * Migration 20260925000100_mmg_refund_rail adds two tables nothing writes yet,
 * one column the store's attestation now writes, and two DEFERRED constraint
 * triggers that make the rail's money rules the database's own:
 *   - THE CAP: the non-void refund obligations of an order never add up to more
 *     than what the store attested it received ("mmgAttestedAmount"); with
 *     nothing attested, none may stand;
 *   - THE PAID-CANCEL GUARD (spec §3.1:5252): an MMG order the store claimed
 *     (CLAIMED) or a provider captured (CAPTURED) never becomes CANCELLED or
 *     REFUNDED without a CANCELLATION obligation committed with it.
 * Both are checked at COMMIT: every refusal below is proved to be a commit-time
 * refusal, and every ordering the deferral exists to allow is proved to commit.
 *
 * Also here: the wall (RLS enabled and forced, tenant from the order), the
 * CHECKs, the unique cause and refund reference, the attestation writing the
 * amount, and the backfill, run from the migration's own text on seeded rows.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { nanoid } from 'nanoid';
import { Prisma, type PaymentMethod, type PaymentStatus, type OrderStatus } from '@prisma/client';
import { prismaPlugin } from '../plugins/prisma';
import { registerErrorHandler } from '../middleware/error-handler';
import { runWithoutTenant } from '../plugins/tenant-context';
import { purgeAuditLogs } from '../lib/audit-immutability';
import { installDdl } from './helpers/install-ddl';
import { grantSuiteCapability } from '../lib/test-target-lock';
import { recordVendorAttestation } from '../modules/vendor/mmg-attestation';
import { MMG_MONEY_MOVED } from '../modules/order/order.service';
import { openMmgRefundObligation, type MmgRefundPolicy } from '../modules/order/mmg-refund-law';

// The NOBYPASSRLS probe needs its grants on the two new tables.
grantSuiteCapability('ddl');

const MIGRATION = readFileSync(
  join(process.cwd(), 'prisma/migrations/20260925000100_mmg_refund_rail/migration.sql'),
  'utf8',
);
const RUN = nanoid(8).replace(/[^a-zA-Z0-9]/g, '0');
/** +592 0925 xxxxx — checked unused across the monorepo before use. */
const PHONE = (n: number) => `+5920925${String((Number.parseInt(RUN.slice(0, 4), 36) % 900) + 100)}${String(n).padStart(2, '0')}`;
const PROBE = 'swift_rls_probe';
const REVIEW = `refund-${RUN.toLowerCase()}`;
const POLICY: MmgRefundPolicy = { deadlineHours: 72, missLimit: 2 };
const D = (v: string) => new Prisma.Decimal(v);
const system = <T>(fn: () => Promise<T>) => runWithoutTenant(fn, 'e02-refund-rail-db-test');

let app: FastifyInstance;
const ids = { customer: '', owner: '', vendorOwner: '', vendor: '', reviewCustomer: '' };
const orderIds: string[] = [];
let seq = 0;

async function makeOrder(opts: {
  paymentMethod?: PaymentMethod;
  paymentStatus?: PaymentStatus;
  status?: OrderStatus;
  total?: string;
  attested?: string | null;
  tenantId?: string;
  customerId?: string;
}) {
  seq += 1;
  const order = await system(() => app.prisma.order.create({
    data: {
      ...(opts.tenantId ? { tenantId: opts.tenantId } : {}),
      orderNumber: `E02-${RUN}-${seq}`,
      orderType: 'GROCERY_DELIVERY',
      customerId: opts.customerId ?? ids.customer,
      vendorId: opts.tenantId ? null : ids.vendor,
      status: opts.status ?? 'PREPARING',
      deliveryAddress: 'x', deliveryLat: 6.8, deliveryLng: -58.15,
      subtotalBase: 2000, subtotalMarkup: 0, subtotalCustomer: 2000, deliveryFee: 300,
      totalAmount: opts.total ?? '2300.00',
      paymentMethod: opts.paymentMethod ?? 'MOBILE_MONEY',
      paymentStatus: opts.paymentStatus ?? 'CLAIMED',
      mmgAttestedAmount: opts.attested === undefined ? (opts.total ?? '2300.00') : opts.attested,
    },
  }));
  orderIds.push(order.id);
  return order;
}

type ObligationKind = 'CANCELLATION' | 'LINE_REMOVED' | 'SUBSTITUTE_REJECTED' | 'SUBSTITUTE_CHEAPER';

/** An OWED obligation exactly as the law opens one. */
function obligationData(orderId: string, amount: string, kind: ObligationKind = 'LINE_REMOVED', over: Partial<Prisma.MmgRefundObligationUncheckedCreateInput> = {}) {
  seq += 1;
  return {
    ...openMmgRefundObligation({
      kind,
      tenantId: 'swift-default',
      orderId,
      vendorId: ids.vendor,
      customerId: ids.customer,
      orderItemId: kind === 'CANCELLATION' ? null : `line-${RUN}-${seq}`,
      amount: D(amount),
      currencyCode: 'GYD',
      basis: kind === 'CANCELLATION' ? 'ATTESTED_REMAINDER' : 'NONE',
      createdById: ids.owner,
    }, POLICY, new Date()),
    ...over,
  };
}

const createObligation = (data: Prisma.MmgRefundObligationUncheckedCreateInput) =>
  system(() => app.prisma.mmgRefundObligation.create({ data }));

function sendData(orderId: string, amount: string, over: Partial<Prisma.MmgRefundSendUncheckedCreateInput> = {}): Prisma.MmgRefundSendUncheckedCreateInput {
  seq += 1;
  return {
    orderId, vendorId: ids.vendor, customerId: ids.customer,
    mmgRefundRef: `RF${RUN.toUpperCase()}${seq}`, amount: D(amount), sentById: ids.owner, coveredObligationIds: [],
    ...over,
  };
}

const orderRow = (id: string) => system(() => app.prisma.order.findUniqueOrThrow({ where: { id }, select: { status: true, paymentStatus: true, mmgAttestedAmount: true } }));
const owedRows = (orderId: string) => system(() => app.prisma.mmgRefundObligation.findMany({ where: { orderId }, select: { amount: true, status: true } }));

beforeAll(async () => {
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(prismaPlugin);
  await app.ready();
  await installDdl(app.prisma, [
    `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${PROBE}') THEN CREATE ROLE ${PROBE} NOLOGIN NOBYPASSRLS; END IF; END $$`,
    `GRANT USAGE ON SCHEMA public TO ${PROBE}`,
    `GRANT SELECT, INSERT, UPDATE, DELETE ON "mmg_refund_obligations", "mmg_refund_sends", "orders" TO ${PROBE}`,
  ]);
  await system(async () => {
    const customer = await app.prisma.user.create({ data: { phone: PHONE(1), firstName: 'Refund', lastName: 'Customer', activeRole: 'CUSTOMER' } });
    const owner = await app.prisma.user.create({ data: { phone: PHONE(2), firstName: 'Refund', lastName: 'Owner', activeRole: 'VENDOR_OWNER' } });
    const vo = await app.prisma.vendorOwner.create({ data: { userId: owner.id } });
    const vendor = await app.prisma.vendor.create({
      data: {
        ownerId: vo.id, name: 'Refund Rail Grocer', slug: `refund-rail-${RUN.toLowerCase()}`, vendorType: 'SUPERMARKET',
        phone: PHONE(3), addressLine1: '1 Ledger St', city: 'Georgetown', region: 'Demerara-Mahaica',
        latitude: 6.801, longitude: -58.156, status: 'ACTIVE',
      },
    });
    await app.prisma.tenant.create({ data: { id: REVIEW, name: 'Refund fiction', slug: REVIEW, kind: 'REVIEW' } });
    const reviewCustomer = await app.prisma.user.create({ data: { phone: PHONE(4), firstName: 'Fiction', lastName: 'Customer', activeRole: 'CUSTOMER', tenantId: REVIEW, isSynthetic: true } });
    Object.assign(ids, { customer: customer.id, owner: owner.id, vendorOwner: vo.id, vendor: vendor.id, reviewCustomer: reviewCustomer.id });
  });
});

afterAll(async () => {
  await system(async () => {
    await app.prisma.mmgRefundObligation.deleteMany({ where: { orderId: { in: orderIds } } });
    await app.prisma.mmgRefundSend.deleteMany({ where: { orderId: { in: orderIds } } });
    await purgeAuditLogs(app.prisma, { entityId: { in: orderIds } }, 'test-cleanup:e02-refund-rail-db');
    await app.prisma.orderStatusLog.deleteMany({ where: { orderId: { in: orderIds } } }).catch(() => undefined);
    await app.prisma.order.deleteMany({ where: { id: { in: orderIds } } });
    await app.prisma.vendor.deleteMany({ where: { id: ids.vendor } });
    await app.prisma.vendorOwner.deleteMany({ where: { id: ids.vendorOwner } });
    await app.prisma.user.deleteMany({ where: { id: { in: [ids.customer, ids.owner, ids.reviewCustomer] } } });
    await app.prisma.tenant.deleteMany({ where: { id: REVIEW } });
  });
  await app.close();
});

describe('[E02] the tables, the wall and the triggers exist as the migration says', () => {
  it('both tables are walled: RLS ENABLED and FORCED, with the canonical tenant policy', async () => {
    const rows = await app.prisma.$queryRaw<Array<{ relname: string; enabled: boolean; forced: boolean; qual: string | null }>>`
      SELECT c.relname, c.relrowsecurity AS enabled, c.relforcerowsecurity AS forced, pg_get_expr(p.polqual, p.polrelid) AS qual
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
        LEFT JOIN pg_policy p ON p.polrelid = c.oid AND p.polname = 'tenant_isolation'
       WHERE c.relname IN ('mmg_refund_obligations', 'mmg_refund_sends')
       ORDER BY c.relname`;
    expect(rows.map((r) => [r.relname, r.enabled, r.forced])).toEqual([
      ['mmg_refund_obligations', true, true],
      ['mmg_refund_sends', true, true],
    ]);
    for (const r of rows) {
      expect(r.qual).toContain('app.current_tenant');
      expect(r.qual).toContain('pg_has_role');
    }
  });

  it('the cap and the paid-cancel guard are constraint triggers, DEFERRABLE INITIALLY DEFERRED', async () => {
    const rows = await app.prisma.$queryRaw<Array<{ tgname: string; rel: string; deferrable: boolean; deferred: boolean }>>`
      SELECT t.tgname, c.relname AS rel, t.tgdeferrable AS deferrable, t.tginitdeferred AS deferred
        FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
       WHERE t.tgname IN ('mmg_refund_obligations_within_attested', 'orders_mmg_attested_holds_refund_obligations', 'orders_paid_mmg_terminal_needs_refund_obligation')
       ORDER BY t.tgname`;
    expect(rows).toEqual([
      { tgname: 'mmg_refund_obligations_within_attested', rel: 'mmg_refund_obligations', deferrable: true, deferred: true },
      { tgname: 'orders_mmg_attested_holds_refund_obligations', rel: 'orders', deferrable: true, deferred: true },
      { tgname: 'orders_paid_mmg_terminal_needs_refund_obligation', rel: 'orders', deferrable: true, deferred: true },
    ]);
  });

  it('the guard’s paid predicate is MMG_MONEY_MOVED, word for word', () => {
    const when = /CREATE CONSTRAINT TRIGGER "orders_paid_mmg_terminal_needs_refund_obligation"[\s\S]*?EXECUTE FUNCTION/.exec(MIGRATION)?.[0] ?? '';
    const lists = [...when.matchAll(/"paymentStatus" IN \(([^)]*)\)/g)].map((m) => m[1]!.split(',').map((s) => s.trim().replace(/'/g, '')).sort());
    expect(lists).toHaveLength(2); // before the change, and after it
    for (const l of lists) expect(l).toEqual([...MMG_MONEY_MOVED].sort());
    expect(when).toContain(`"paymentMethod" = 'MOBILE_MONEY'`);
  });
});

describe('[E02] the CHECKs and the unique keys', () => {
  it('an obligation or a send is never zero or negative', async () => {
    const order = await makeOrder({});
    for (const amount of ['0.00', '-1.00']) {
      await expect(createObligation({ ...obligationData(order.id, '1.00'), amount: D(amount) }))
        .rejects.toThrow(/chk_mmg_refund_obligations_amount_positive/);
      await expect(system(() => app.prisma.mmgRefundSend.create({ data: sendData(order.id, amount) })))
        .rejects.toThrow(/chk_mmg_refund_sends_amount_positive/);
    }
  });

  it('the fee Swift pays back is never negative; zero and unrecorded are fine', async () => {
    const order = await makeOrder({});
    await expect(system(() => app.prisma.mmgRefundSend.create({ data: sendData(order.id, '10.00', { feeBorneBySwift: D('-0.01') }) })))
      .rejects.toThrow(/chk_mmg_refund_sends_fee_nonneg/);
    await expect(system(() => app.prisma.mmgRefundSend.create({ data: sendData(order.id, '10.00', { feeBorneBySwift: D('0') }) }))).resolves.toBeTruthy();
    await expect(system(() => app.prisma.mmgRefundSend.create({ data: sendData(order.id, '10.00') }))).resolves.toBeTruthy();
  });

  it('an obligation names a send exactly while SENT, CONFIRMED, DISPUTED or SETTLED', async () => {
    const order = await makeOrder({ total: '5000.00' });
    const send = await system(() => app.prisma.mmgRefundSend.create({ data: sendData(order.id, '10.00') }));
    for (const status of ['SENT', 'CONFIRMED', 'DISPUTED', 'SETTLED'] as const) {
      await expect(createObligation(obligationData(order.id, '10.00', 'LINE_REMOVED', { status, sendId: null })), status)
        .rejects.toThrow(/chk_mmg_refund_obligations_send_shape/);
      await expect(createObligation(obligationData(order.id, '10.00', 'LINE_REMOVED', { status, sendId: send.id })), status).resolves.toBeTruthy();
    }
    for (const status of ['OWED', 'VOIDED'] as const) {
      await expect(createObligation(obligationData(order.id, '10.00', 'LINE_REMOVED', { status, sendId: send.id })), status)
        .rejects.toThrow(/chk_mmg_refund_obligations_send_shape/);
    }
  });

  it('one obligation per cause, and one send per MMG refund reference', async () => {
    const order = await makeOrder({});
    const first = obligationData(order.id, '100.00', 'CANCELLATION');
    await createObligation(first);
    await expect(createObligation({ ...obligationData(order.id, '100.00', 'CANCELLATION'), causeKey: first.causeKey }))
      .rejects.toMatchObject({ code: 'P2002' });
    const ref = `RFDUP${RUN.toUpperCase()}`;
    await system(() => app.prisma.mmgRefundSend.create({ data: sendData(order.id, '10.00', { mmgRefundRef: ref }) }));
    await expect(system(() => app.prisma.mmgRefundSend.create({ data: sendData(order.id, '10.00', { mmgRefundRef: ref }) })))
      .rejects.toMatchObject({ code: 'P2002' });
  });
});

describe('[E02] THE CAP: obligations never add up to more than the store attested (deferred)', () => {
  it('exactly the attested amount commits; a voided obligation frees its share', async () => {
    const order = await makeOrder({ total: '2300.00' });
    await createObligation(obligationData(order.id, '2300.00', 'LINE_REMOVED', { status: 'VOIDED' }));
    await createObligation(obligationData(order.id, '2000.00'));
    await createObligation(obligationData(order.id, '300.00'));
    const owed = (await owedRows(order.id)).filter((r) => r.status !== 'VOIDED').reduce((s, r) => s.plus(r.amount), D('0'));
    expect(owed.equals(D('2300'))).toBe(true);
  });

  it('an over-cap insert SUCCEEDS as a statement and is refused at COMMIT — and leaves nothing behind', async () => {
    const order = await makeOrder({ total: '2300.00' });
    const data = obligationData(order.id, '2300.01');
    let seenInsideTransaction = false;
    await expect(app.prisma.$transaction(async (tx) => {
      await tx.mmgRefundObligation.create({ data });
      // Still inside the transaction: the row is there — the check has not run yet.
      seenInsideTransaction = (await tx.mmgRefundObligation.count({ where: { causeKey: data.causeKey } })) === 1;
    })).rejects.toThrow(/MMG_REFUND_OVER_ATTESTED/);
    expect(seenInsideTransaction).toBe(true);
    expect(await system(() => app.prisma.mmgRefundObligation.count({ where: { causeKey: data.causeKey } }))).toBe(0);
  });

  it('a second obligation that tips the sum over is refused, even when each alone fits', async () => {
    const order = await makeOrder({ total: '2300.00' });
    await createObligation(obligationData(order.id, '1500.00'));
    await expect(createObligation(obligationData(order.id, '800.01'))).rejects.toThrow(/MMG_REFUND_OVER_ATTESTED/);
    await expect(createObligation(obligationData(order.id, '800.00'))).resolves.toBeTruthy();
  });

  it('nothing attested, nothing may be owed', async () => {
    const order = await makeOrder({ attested: null });
    await expect(createObligation(obligationData(order.id, '0.01'))).rejects.toThrow(/MMG_REFUND_OVER_ATTESTED/);
  });

  it('the deferral allows either order inside one transaction: owe first, attest after, commits', async () => {
    const order = await makeOrder({ attested: null });
    await app.prisma.$transaction(async (tx) => {
      await tx.mmgRefundObligation.create({ data: obligationData(order.id, '2300.00', 'CANCELLATION') });
      await tx.order.update({ where: { id: order.id }, data: { mmgAttestedAmount: D('2300.00') } });
    });
    expect((await owedRows(order.id))).toHaveLength(1);
  });

  it('from the orders side too: lowering or clearing the attested amount under what is owed is refused at commit', async () => {
    const order = await makeOrder({ total: '2300.00' });
    await createObligation(obligationData(order.id, '2000.00'));
    await expect(system(() => app.prisma.order.update({ where: { id: order.id }, data: { mmgAttestedAmount: D('1999.99') } })))
      .rejects.toThrow(/MMG_REFUND_OVER_ATTESTED/);
    await expect(system(() => app.prisma.order.update({ where: { id: order.id }, data: { mmgAttestedAmount: null } })))
      .rejects.toThrow(/MMG_REFUND_OVER_ATTESTED/);
    expect((await orderRow(order.id)).mmgAttestedAmount?.toFixed(2)).toBe('2300.00');
    await expect(system(() => app.prisma.order.update({ where: { id: order.id }, data: { mmgAttestedAmount: D('2000.00') } }))).resolves.toBeTruthy();
  });

  it('raising an obligation, or un-voiding one, is judged like a new one', async () => {
    const order = await makeOrder({ total: '2300.00' });
    const a = await createObligation(obligationData(order.id, '2000.00'));
    const voided = await createObligation(obligationData(order.id, '1000.00', 'LINE_REMOVED', { status: 'VOIDED' }));
    await expect(system(() => app.prisma.mmgRefundObligation.update({ where: { id: a.id }, data: { amount: D('2300.01') } })))
      .rejects.toThrow(/MMG_REFUND_OVER_ATTESTED/);
    await expect(system(() => app.prisma.mmgRefundObligation.update({ where: { id: voided.id }, data: { status: 'OWED' } })))
      .rejects.toThrow(/MMG_REFUND_OVER_ATTESTED/);
  });

  it('two transactions racing to owe the same order: exactly one commits (the order row lock serialises the check)', async () => {
    const order = await makeOrder({ total: '2300.00' });
    let firstChecked!: () => void;
    const firstHasChecked = new Promise<void>((resolve) => { firstChecked = resolve; });
    let secondDone = false;

    // The first transaction runs its deferred check NOW (holding the order row
    // lock) and stays open. The second then runs its own: with the lock it must
    // wait for the first to commit and then see its row; without it, it would
    // see neither and both would commit.
    const first = app.prisma.$transaction(async (tx) => {
      await tx.mmgRefundObligation.create({ data: obligationData(order.id, '1500.00') });
      await tx.$executeRawUnsafe('SET CONSTRAINTS "mmg_refund_obligations_within_attested" IMMEDIATE');
      firstChecked();
      // Hold the transaction open until the second is either blocked on the
      // row lock or has finished its own check.
      for (let i = 0; i < 200 && !secondDone; i += 1) {
        const waiting = await app.prisma.$queryRaw<Array<{ n: bigint }>>`
          SELECT count(*)::bigint AS n FROM pg_stat_activity
           WHERE datname = current_database() AND wait_event_type = 'Lock' AND pid <> pg_backend_pid()`;
        if (Number(waiting[0]!.n) > 0) break;
        await new Promise((r) => setTimeout(r, 25));
      }
    }, { timeout: 20_000 });
    const second = firstHasChecked.then(() => app.prisma.$transaction(async (tx) => {
      await tx.mmgRefundObligation.create({ data: obligationData(order.id, '1500.00') });
      try {
        await tx.$executeRawUnsafe('SET CONSTRAINTS "mmg_refund_obligations_within_attested" IMMEDIATE');
      } finally {
        secondDone = true;
      }
    }, { timeout: 20_000 }));

    const results = await Promise.allSettled([first, second]);
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'rejected']);
    expect(String((results[1] as PromiseRejectedResult).reason)).toMatch(/MMG_REFUND_OVER_ATTESTED/);
    const rows = await owedRows(order.id);
    expect(rows.reduce((s, r) => s.plus(r.amount), D('0')).equals(D('1500'))).toBe(true);
  });
});

describe('[E02] THE PAID-CANCEL GUARD: a paid MMG order is never cancelled or refunded without its CANCELLATION obligation', () => {
  const setStatus = (id: string, status: OrderStatus) =>
    app.prisma.$executeRaw`UPDATE "orders" SET "status" = ${status}::"OrderStatus" WHERE "id" = ${id}`;

  it.each([
    ['CLAIMED', 'CANCELLED'],
    ['CLAIMED', 'REFUNDED'],
    ['CAPTURED', 'CANCELLED'],
    ['CAPTURED', 'REFUNDED'],
  ] as const)('raw SQL: a %s MMG order cannot become %s without one', async (paymentStatus, target) => {
    const order = await makeOrder({ paymentStatus });
    await expect(setStatus(order.id, target)).rejects.toThrow(/MMG_REFUND_OBLIGATION_REQUIRED/);
    expect((await orderRow(order.id)).status).toBe('PREPARING');
  });

  it('the ORM is held to the same rule (no path is special)', async () => {
    const order = await makeOrder({});
    await expect(system(() => app.prisma.order.update({ where: { id: order.id }, data: { status: 'CANCELLED', cancelledAt: new Date() } })))
      .rejects.toThrow(/MMG_REFUND_OBLIGATION_REQUIRED/);
  });

  it('with its CANCELLATION obligation it commits — and deferral lets the obligation be written AFTER the status', async () => {
    const order = await makeOrder({});
    await app.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`UPDATE "orders" SET "status" = 'CANCELLED'::"OrderStatus" WHERE "id" = ${order.id}`;
      await tx.mmgRefundObligation.create({ data: obligationData(order.id, '2300.00', 'CANCELLATION') });
    });
    expect((await orderRow(order.id)).status).toBe('CANCELLED');
    // A later accounting move to REFUNDED still finds the obligation.
    await expect(setStatus(order.id, 'REFUNDED')).resolves.toBe(1);
  });

  it('an obligation already there lets the status change stand alone', async () => {
    const order = await makeOrder({ paymentStatus: 'CAPTURED' });
    await createObligation(obligationData(order.id, '2300.00', 'CANCELLATION'));
    await expect(setStatus(order.id, 'CANCELLED')).resolves.toBe(1);
  });

  it('only a live CANCELLATION obligation counts: a voided one, or a line obligation, does not', async () => {
    const voided = await makeOrder({});
    await createObligation(obligationData(voided.id, '2300.00', 'CANCELLATION', { status: 'VOIDED' }));
    await expect(setStatus(voided.id, 'CANCELLED')).rejects.toThrow(/MMG_REFUND_OBLIGATION_REQUIRED/);
    const lined = await makeOrder({});
    await createObligation(obligationData(lined.id, '2300.00', 'LINE_REMOVED'));
    await expect(setStatus(lined.id, 'CANCELLED')).rejects.toThrow(/MMG_REFUND_OBLIGATION_REQUIRED/);
  });

  it('one statement cannot mint a paid-and-cancelled order by rewriting the payment state beside the status', async () => {
    const pending = await makeOrder({ paymentStatus: 'PENDING', attested: null });
    await expect(app.prisma.$executeRaw`UPDATE "orders" SET "status" = 'CANCELLED', "paymentStatus" = 'CLAIMED' WHERE "id" = ${pending.id}`)
      .rejects.toThrow(/MMG_REFUND_OBLIGATION_REQUIRED/);
    const claimed = await makeOrder({});
    await expect(app.prisma.$executeRaw`UPDATE "orders" SET "status" = 'CANCELLED', "paymentStatus" = 'PENDING' WHERE "id" = ${claimed.id}`)
      .rejects.toThrow(/MMG_REFUND_OBLIGATION_REQUIRED/);
  });

  it('everything else is untouched: unpaid MMG, cash, other moves, same-status writes, and existing rows', async () => {
    const pendingMmg = await makeOrder({ paymentStatus: 'PENDING', attested: null });
    await expect(setStatus(pendingMmg.id, 'CANCELLED')).resolves.toBe(1);
    const cash = await makeOrder({ paymentMethod: 'CASH', paymentStatus: 'CAPTURED', attested: null });
    await expect(setStatus(cash.id, 'CANCELLED')).resolves.toBe(1);
    const moving = await makeOrder({});
    await expect(setStatus(moving.id, 'READY_FOR_PICKUP')).resolves.toBe(1);
    await expect(setStatus(moving.id, 'DELIVERED')).resolves.toBe(1);
    // History from before the guard: born CANCELLED+CAPTURED, never judged, still writable.
    const legacy = await makeOrder({ status: 'CANCELLED', paymentStatus: 'CAPTURED' });
    await expect(setStatus(legacy.id, 'CANCELLED')).resolves.toBe(1); // no transition
    await expect(system(() => app.prisma.order.update({ where: { id: legacy.id }, data: { cancellationReason: 'legacy note' } }))).resolves.toBeTruthy();
  });
});

describe('[E02] the wall and the lineage on the new tables', () => {
  it('an obligation takes its order’s tenant, an explicit disagreement is refused, and another tenant cannot see it', async () => {
    const fiction = await makeOrder({ tenantId: REVIEW, customerId: ids.reviewCustomer });
    const created = await createObligation({ ...obligationData(fiction.id, '100.00'), tenantId: 'swift-default' });
    expect(created.tenantId).toBe(REVIEW); // unstamped → derived from the order
    await expect(createObligation({ ...obligationData(fiction.id, '100.00'), tenantId: `other-${RUN}` }))
      .rejects.toThrow(/STA-1 lineage|Foreign key/);
    const send = await system(() => app.prisma.mmgRefundSend.create({ data: sendData(fiction.id, '100.00') }));
    expect(send.tenantId).toBe(REVIEW);

    const visible = (tenant: string) => app.prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL ROLE ${PROBE}`);
      await tx.$executeRawUnsafe(`SET LOCAL app.current_tenant = '${tenant}'`);
      const o = await tx.$queryRaw<Array<{ n: bigint }>>`SELECT count(*)::bigint AS n FROM "mmg_refund_obligations" WHERE "orderId" = ${fiction.id}`;
      const s = await tx.$queryRaw<Array<{ n: bigint }>>`SELECT count(*)::bigint AS n FROM "mmg_refund_sends" WHERE "orderId" = ${fiction.id}`;
      return [Number(o[0]!.n), Number(s[0]!.n)];
    });
    expect(await visible(REVIEW)).toEqual([1, 1]);
    expect(await visible('swift-default')).toEqual([0, 0]);
  });
});

describe('[E02] the attestation writes the cap', () => {
  it('recordVendorAttestation stores the attested amount on the order, to the cent, in the same write as the reference', async () => {
    const order = await makeOrder({ paymentStatus: 'PENDING', attested: null, total: '2345.67' });
    const reference = `ATT${RUN.toUpperCase()}`;
    const result = await system(() => app.prisma.$transaction((tx) => recordVendorAttestation(tx, {
      orderId: order.id, reference, actorId: ids.owner, amount: order.totalAmount, recipientName: 'Refund Rail Grocer',
    })));
    expect(result).toEqual({ ok: true });
    const after = await system(() => app.prisma.order.findUniqueOrThrow({ where: { id: order.id }, select: { mmgAttestedRef: true, mmgAttestedAmount: true } }));
    expect(after.mmgAttestedRef).toBe(reference);
    expect(after.mmgAttestedAmount?.toFixed(2)).toBe('2345.67');
    const audit = await system(() => app.prisma.auditLog.findFirstOrThrow({ where: { entityId: order.id, action: 'ATTEST_MMG_PAYMENT' } }));
    expect(D((audit.changes as { amount: string }).amount).equals(after.mmgAttestedAmount!)).toBe(true); // one figure, two records
  });
});

describe('[E02] the backfill, run from the migration’s own text', () => {
  it('a paid MMG order takes its latest attestation amount, else its total; nothing else is touched', async () => {
    const statement = /WITH attested AS \([\s\S]*?;/.exec(MIGRATION)?.[0];
    expect(statement, 'the backfill statement is in the migration').toBeTruthy();

    const audited = await makeOrder({ paymentStatus: 'CLAIMED', attested: null, total: '2300.00' });
    const noAudit = await makeOrder({ paymentStatus: 'CAPTURED', attested: null, total: '1800.50' });
    const badAudit = await makeOrder({ paymentStatus: 'CLAIMED', attested: null, total: '999.00' });
    const unpaid = await makeOrder({ paymentStatus: 'PENDING', attested: null });
    const cash = await makeOrder({ paymentMethod: 'CASH', paymentStatus: 'CAPTURED', attested: null });
    const already = await makeOrder({ paymentStatus: 'CLAIMED', attested: '1234.56' });
    const audit = (entityId: string, amount: string, createdAt: Date) => system(() => app.prisma.auditLog.create({
      data: { userId: ids.owner, action: 'ATTEST_MMG_PAYMENT', entity: 'Order', entityId, createdAt, changes: { reference: `R${nanoid(6)}`, amount, currency: 'GYD', basis: 'VENDOR_ATTESTED' } },
    }));
    await audit(audited.id, '1999', new Date(Date.now() - 60_000));
    await audit(audited.id, '2300', new Date()); // the latest wins
    await audit(badAudit.id, '9,99', new Date()); // not a decimal: the total stands in

    const ROLLBACK = new Error('rollback: the backfill proof leaves shared rows as it found them');
    const seen = await app.prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(statement!);
      const rows = await tx.order.findMany({
        where: { id: { in: [audited.id, noAudit.id, badAudit.id, unpaid.id, cash.id, already.id] } },
        select: { id: true, mmgAttestedAmount: true },
      });
      throw Object.assign(ROLLBACK, { rows });
    }).catch((err: Error & { rows?: Array<{ id: string; mmgAttestedAmount: Prisma.Decimal | null }> }) => {
      if (err !== ROLLBACK) throw err;
      return new Map(err.rows!.map((r) => [r.id, r.mmgAttestedAmount?.toFixed(2) ?? null]));
    });
    expect(seen.get(audited.id)).toBe('2300.00');
    expect(seen.get(noAudit.id)).toBe('1800.50');
    expect(seen.get(badAudit.id)).toBe('999.00');
    expect(seen.get(unpaid.id)).toBeNull();
    expect(seen.get(cash.id)).toBeNull();
    expect(seen.get(already.id)).toBe('1234.56');
    // And the transaction really rolled back.
    expect((await orderRow(audited.id)).mmgAttestedAmount).toBeNull();
  });
});
