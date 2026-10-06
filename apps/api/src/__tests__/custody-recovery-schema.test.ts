/**
 * [AF-MOB-006] The custody recovery case's contract, graded on a MIGRATED
 * database (this suite installs nothing: what it finds is what the migration
 * built) and on the law in order-status.ts.
 *
 *  - walled like every tenant table (RLS enabled AND forced, canonical policy,
 *    both registries) and a case inherits its order's tenant (lineage);
 *  - ONE open case per order (a partial unique index);
 *  - the database's open/resolved split is the law's split, state for state;
 *  - a transfer code exists only while a transfer is in progress;
 *  - a case never moves to another order or tenant;
 *  - the law: no edge leaves a resolved state, every resolved state is
 *    reachable, the forward custody set is the in-custody set minus RETURNING.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { CustodyRecoveryState, type Prisma } from '@prisma/client';
import { nanoid } from 'nanoid';
import { prismaPlugin, TENANT_MODEL_NAMES } from '../plugins/prisma';
import { runWithoutTenant } from '../plugins/tenant-context';
import { TENANT_TABLES, TENANT_LINEAGE_TABLES } from '../lib/tenant-rls';
import {
  CUSTODY_CASE_LAW,
  CUSTODY_CASE_OPEN_STATES,
  CUSTODY_CASE_TRANSITIONS,
  RIDER_FORWARD_CUSTODY_STATUSES,
  RIDER_IN_CUSTODY_STATUSES,
  isCustodyCaseOpen,
  isCustodyCaseTransition,
} from '../modules/order/order-status';

const RUN = nanoid(8).replace(/[^a-zA-Z0-9]/g, '0');
let app: FastifyInstance;
const system = <T>(fn: () => Promise<T>) => runWithoutTenant(fn, 'custody-schema-test');
const STATES = Object.values(CustodyRecoveryState) as CustodyRecoveryState[];
const userIds: string[] = [];
const orderIds: string[] = [];

async function order(): Promise<string> {
  const user = await system(() => app.prisma.user.create({
    data: { phone: `+59200CUS${String(Date.now()).slice(-5)}${userIds.length}`, firstName: 'Case', lastName: 'Schema', activeRole: 'CUSTOMER' },
    select: { id: true },
  }));
  userIds.push(user.id);
  const o = await system(() => app.prisma.order.create({ data: {
    orderNumber: `CUS-${RUN}-${orderIds.length}`, orderType: 'FOOD_DELIVERY', customerId: user.id, status: 'EN_ROUTE_DELIVERY',
    deliveryAddress: 'Case Street', deliveryLat: 6.8, deliveryLng: -58.15,
    subtotalBase: 1000, subtotalMarkup: 0, subtotalCustomer: 1000, deliveryFee: 300, totalAmount: 1300, paymentMethod: 'CASH',
  } }));
  orderIds.push(o.id);
  return o.id;
}

const kase = (orderId: string, extra: Partial<Prisma.CustodyRecoveryCaseUncheckedCreateInput> = {}) =>
  system(() => app.prisma.custodyRecoveryCase.create({ data: {
    orderId, reason: 'VEHICLE_BREAKDOWN', holderRiderId: 'rider-x', deadlineAt: new Date(Date.now() + 600_000), ...extra,
  } }));

beforeAll(async () => {
  app = Fastify({ logger: false });
  await app.register(prismaPlugin);
  await app.ready();
});

afterAll(async () => {
  await system(async () => {
    await app.prisma.order.deleteMany({ where: { id: { in: orderIds } } });
    await app.prisma.user.deleteMany({ where: { id: { in: userIds } } });
  });
  await app.close();
});

describe('[AF-MOB-006] the case law', () => {
  it('classifies every state the database defines, in both tables — none unclassified, no stray key', () => {
    expect(Object.keys(CUSTODY_CASE_LAW).sort()).toEqual([...STATES].sort());
    expect(Object.keys(CUSTODY_CASE_TRANSITIONS).sort()).toEqual([...STATES].sort());
    expect([...CUSTODY_CASE_OPEN_STATES].sort()).toEqual(['RELAY_REQUIRED', 'RETURN_REQUIRED', 'SUPPORT_HOLD', 'TRANSFER_IN_PROGRESS']);
    for (const s of STATES) expect(isCustodyCaseOpen(s)).toBe(CUSTODY_CASE_OPEN_STATES.includes(s));
  });

  it('nothing leaves a resolved state, and every edge starts from an open one', () => {
    for (const to of STATES) {
      for (const from of CUSTODY_CASE_TRANSITIONS[to]) {
        expect(isCustodyCaseOpen(from), `${from} -> ${to}`).toBe(true);
        expect(isCustodyCaseTransition(from, to)).toBe(true);
      }
    }
  });

  it('every resolved state is reachable, and a return cannot start under a pending handoff', () => {
    for (const s of STATES.filter((x) => !isCustodyCaseOpen(x))) expect(CUSTODY_CASE_TRANSITIONS[s].length).toBeGreaterThan(0);
    expect(isCustodyCaseTransition('TRANSFER_IN_PROGRESS', 'RETURN_REQUIRED')).toBe(false);
    expect(CUSTODY_CASE_TRANSITIONS.TRANSFERRED).toEqual(['TRANSFER_IN_PROGRESS']);
    expect(CUSTODY_CASE_TRANSITIONS.RETURNED).toEqual(['RETURN_REQUIRED']);
  });

  it('the forward custody set is the in-custody set minus a parcel already on its way back', () => {
    expect([...RIDER_FORWARD_CUSTODY_STATUSES].sort())
      .toEqual(RIDER_IN_CUSTODY_STATUSES.filter((s) => s !== 'RETURNING').sort());
  });
});

describe('[AF-MOB-006] custody_recovery_cases is walled like every tenant table', () => {
  it('is in both registries and the lineage rule names its order', () => {
    expect(TENANT_TABLES).toContain('custody_recovery_cases');
    expect(TENANT_MODEL_NAMES).toContain('custodyRecoveryCase');
    expect(TENANT_LINEAGE_TABLES.find((r) => r.table === 'custody_recovery_cases')).toMatchObject({
      trigger: 'custody_recovery_cases_tenant_matches_order', parent: 'orders', fk: 'orderId',
    });
  });

  it('RLS is enabled and forced, and the triggers and constraints exist', async () => {
    const [rls] = await app.prisma.$queryRawUnsafe<Array<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>>(`
      SELECT c.relrowsecurity, c.relforcerowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = 'custody_recovery_cases'`);
    expect(rls).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
    const triggers = await app.prisma.$queryRawUnsafe<Array<{ tgname: string }>>(`
      SELECT tgname FROM pg_trigger WHERE tgrelid = 'public.custody_recovery_cases'::regclass AND NOT tgisinternal ORDER BY 1`);
    expect(triggers.map((t) => t.tgname)).toEqual(['custody_recovery_cases_identity_frozen', 'custody_recovery_cases_tenant_matches_order']);
  });
});

describe('[AF-MOB-006] the database holds the case invariants', () => {
  it('one OPEN case per order; a resolved one does not block the next incident', async () => {
    const o = await order();
    const first = await kase(o);
    await expect(kase(o)).rejects.toThrow(/custody_recovery_cases_one_open_per_order|Unique constraint/);
    await system(() => app.prisma.custodyRecoveryCase.update({ where: { id: first.id }, data: { state: 'DELIVERED', resolvedAt: new Date() } }));
    const second = await kase(o);
    expect(second.id).not.toBe(first.id);
  });

  it('the open/resolved CHECK is the law, state for state', async () => {
    const o = await order();
    const c = await kase(o);
    for (const state of STATES) {
      const open = isCustodyCaseOpen(state);
      const extra = state === 'TRANSFER_IN_PROGRESS' ? { relayRiderId: 'rider-y' } : {};
      // The law's answer is accepted...
      await system(() => app.prisma.custodyRecoveryCase.update({
        where: { id: c.id }, data: { state, resolvedAt: open ? null : new Date(), ...extra },
      }));
      // ...and the contradiction is refused.
      await expect(system(() => app.prisma.custodyRecoveryCase.update({
        where: { id: c.id }, data: { state, resolvedAt: open ? new Date() : null },
      }))).rejects.toThrow(/custody_recovery_cases_open_law_check/);
    }
  });

  it('a transfer code exists only while a transfer is in progress with a named relay rider', async () => {
    const o = await order();
    // Every code carries its own expiry (below), so these give one; what they
    // grade is the state/relay window.
    const exp = new Date(Date.now() + 600_000);
    await expect(kase(o, { transferCode: '123456', transferCodeExpiresAt: exp })).rejects.toThrow(/custody_recovery_cases_transfer_code_check/);
    await expect(kase(o, { state: 'TRANSFER_IN_PROGRESS', transferCode: '123456', transferCodeExpiresAt: exp })).rejects.toThrow(/custody_recovery_cases_transfer_code_check/);
    const ok = await kase(o, { state: 'TRANSFER_IN_PROGRESS', transferCode: '123456', transferCodeExpiresAt: exp, relayRiderId: 'rider-y' });
    expect(ok.transferCode).toBe('123456');
  });

  it('[Fable r2] a code always carries its own expiry, and an expiry never outlives its code', async () => {
    const o = await order();
    await expect(kase(o, { state: 'TRANSFER_IN_PROGRESS', transferCode: '123456', relayRiderId: 'rider-y' }))
      .rejects.toThrow(/custody_recovery_cases_code_expiry_check/);
    await expect(kase(o, { transferCodeExpiresAt: new Date() })).rejects.toThrow(/custody_recovery_cases_code_expiry_check/);
  });

  it('a case never moves to another order or tenant', async () => {
    const a = await order();
    const b = await order();
    const c = await kase(a);
    await expect(system(() => app.prisma.custodyRecoveryCase.update({ where: { id: c.id }, data: { orderId: b } })))
      .rejects.toThrow(/frozen/);
  });

  it('a case for an order that does not exist is refused by lineage', async () => {
    await expect(kase(`missing-${RUN}`)).rejects.toThrow(/STA-1 lineage|Foreign key/);
  });
});
