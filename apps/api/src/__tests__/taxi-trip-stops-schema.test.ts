/**
 * [TAXI multi-stop 1/8] The stop table's database contract, graded on the
 * database itself — a MIGRATED one (CI's API job replays every migration, and
 * this suite installs nothing: what it finds is what the migration built).
 *
 * taxi_trip_stops holds the intermediate stops of one taxi ride (sequence
 * 1..3; the pickup and the final destination stay on the order). It is walled
 * like every tenant table (RLS enabled AND forced, the canonical policy, both
 * registries), a stop inherits its ride's tenant (lineage), a ride's stops go
 * with it (cascade), and the itinerary is frozen once written: id,
 * tenantId, orderId and sequence never change, while status and its timestamps
 * stay free to move as the ride runs. Nothing in the app reads any of it yet.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { Prisma } from '@prisma/client';
import { nanoid } from 'nanoid';
import { prismaPlugin, TENANT_MODEL_NAMES } from '../plugins/prisma';
import { registerErrorHandler } from '../middleware/error-handler';
import { runWithTenant, runWithoutTenant } from '../plugins/tenant-context';
import { TENANT_TABLES, TENANT_LINEAGE_TABLES, policyPredicateIsCanonical } from '../lib/tenant-rls';

const RUN = nanoid(8).replace(/[^a-zA-Z0-9]/g, '0');
const NUM = String(Date.now()).slice(-6);
const REVIEW = `stops-${RUN}`;
const PRODUCTION = 'swift-default';
let app: FastifyInstance;
const ids = { reviewUser: '', prodUser: '' };
const orderIds: string[] = [];
const system = <T>(fn: () => Promise<T>) => runWithoutTenant(fn, 'taxi-stops-schema-test');

async function taxiOrder(tenantId: string, customerId: string, extra: Partial<Prisma.OrderUncheckedCreateInput> = {}) {
  const order = await system(() => app.prisma.order.create({ data: {
    tenantId, orderNumber: `STOP-${RUN}-${orderIds.length}`, orderType: 'TAXI', customerId,
    pickupAddress: 'Stabroek Market', pickupLat: 6.8045, pickupLng: -58.1553,
    deliveryAddress: 'Sheriff Street', deliveryLat: 6.82, deliveryLng: -58.13,
    subtotalBase: 1500, subtotalMarkup: 0, subtotalCustomer: 1500, deliveryFee: 0, totalAmount: 1500, paymentMethod: 'CASH',
    ...extra,
  } }));
  orderIds.push(order.id);
  return order;
}

const stopData = (orderId: string, sequence: number, extra: Partial<Prisma.TaxiTripStopUncheckedCreateInput> = {}): Prisma.TaxiTripStopUncheckedCreateInput =>
  ({ orderId, sequence, lat: 6.81, lng: -58.15, address: `Stop ${sequence} ${RUN}`, ...extra });
const stop = (orderId: string, sequence: number, extra: Partial<Prisma.TaxiTripStopUncheckedCreateInput> = {}) =>
  system(() => app.prisma.taxiTripStop.create({ data: stopData(orderId, sequence, extra) }));

beforeAll(async () => {
  process.env['NODE_ENV'] = 'development';
  process.env['DATABASE_URL'] = process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift_test';
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(prismaPlugin);
  await app.ready();
  await system(async () => {
    await app.prisma.tenant.create({ data: { id: REVIEW, name: 'Stops fiction', slug: REVIEW, kind: 'REVIEW', purgeProtected: true } });
    const mk = (tenantId: string, phone: string) => app.prisma.user.create({
      data: { phone, firstName: 'Stop', lastName: 'Rider', activeRole: 'CUSTOMER', tenantId, isSynthetic: tenantId !== PRODUCTION },
      select: { id: true },
    });
    ids.reviewUser = (await mk(REVIEW, `+59200STOP${NUM}1`)).id;
    ids.prodUser = (await mk(PRODUCTION, `+59200STOP${NUM}2`)).id;
  });
});

afterAll(async () => {
  await system(async () => {
    // Deleting the rides cascades their stops: the teardown is itself the cascade path.
    await app.prisma.order.deleteMany({ where: { id: { in: orderIds } } });
    await app.prisma.user.deleteMany({ where: { id: { in: [ids.reviewUser, ids.prodUser] } } });
    await app.prisma.tenant.updateMany({ where: { id: REVIEW }, data: { purgeProtected: false } });
    await app.prisma.tenant.deleteMany({ where: { id: REVIEW } });
  });
  await app.close();
});

describe('[TAXI multi-stop] taxi_trip_stops is walled like every tenant table', () => {
  it('is in both registries and has a lineage rule to its ride', () => {
    expect(TENANT_TABLES).toContain('taxi_trip_stops');
    expect(TENANT_MODEL_NAMES).toContain('taxiTripStop');
    expect(TENANT_LINEAGE_TABLES.find((r) => r.table === 'taxi_trip_stops')).toMatchObject({
      trigger: 'taxi_trip_stops_tenant_matches_order', parent: 'orders', fk: 'orderId',
    });
  });

  it('RLS is ENABLED and FORCED, under exactly one policy, and that policy is the canonical one', async () => {
    const [cls] = await app.prisma.$queryRaw<{ enabled: boolean; forced: boolean }[]>(Prisma.sql`
      SELECT c.relrowsecurity AS enabled, c.relforcerowsecurity AS forced
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = 'taxi_trip_stops'`);
    expect(cls).toEqual({ enabled: true, forced: true });
    const policies = await app.prisma.$queryRaw<{ name: string; cmd: string; qual: string | null; withCheck: string | null }[]>(Prisma.sql`
      SELECT p.polname AS name, p.polcmd::text AS cmd,
             pg_get_expr(p.polqual, p.polrelid) AS qual, pg_get_expr(p.polwithcheck, p.polrelid) AS "withCheck"
      FROM pg_policy p WHERE p.polrelid = 'public.taxi_trip_stops'::regclass`);
    expect(policies.map((p) => [p.name, p.cmd])).toEqual([['tenant_isolation', '*']]);
    expect(policyPredicateIsCanonical(policies[0]!.qual)).toBe(true);
    expect(policyPredicateIsCanonical(policies[0]!.withCheck)).toBe(true);
  });

  it('carries its guards: the lineage trigger, the identity freeze, and the bounds', async () => {
    const triggers = await app.prisma.$queryRaw<{ tgname: string }[]>(Prisma.sql`
      SELECT tgname FROM pg_trigger WHERE tgrelid = 'public.taxi_trip_stops'::regclass AND NOT tgisinternal ORDER BY 1`);
    expect(triggers.map((t) => t.tgname)).toEqual(['taxi_trip_stops_identity_frozen', 'taxi_trip_stops_tenant_matches_order']);
    const checks = await app.prisma.$queryRaw<{ conname: string }[]>(Prisma.sql`
      SELECT conname FROM pg_constraint
      WHERE contype = 'c' AND conrelid IN ('public.taxi_trip_stops'::regclass, 'public.orders'::regclass)
        AND (conname LIKE 'taxi_trip_stops_%' OR conname = 'orders_taxi_stop_count_check') ORDER BY 1`);
    expect(checks.map((c) => c.conname)).toEqual([
      'orders_taxi_stop_count_check', 'taxi_trip_stops_address_check', 'taxi_trip_stops_lat_check',
      'taxi_trip_stops_lng_check', 'taxi_trip_stops_sequence_check',
    ]);
  });
});

describe('[TAXI multi-stop] a stop inherits its ride’s tenant', () => {
  it('system mode (the default tenant = unstamped) is DERIVED from the ride — never stored as production', async () => {
    const ride = await taxiOrder(REVIEW, ids.reviewUser);
    expect((await stop(ride.id, 1)).tenantId).toBe(REVIEW);
  });

  it('a stop written INSIDE the ride’s own create inherits too — the shape the request path will use', async () => {
    const ride = await system(() => app.prisma.order.create({
      data: {
        tenantId: REVIEW, orderNumber: `STOP-${RUN}-nested`, orderType: 'TAXI', customerId: ids.reviewUser,
        deliveryAddress: 'Sheriff Street', deliveryLat: 6.82, deliveryLng: -58.13, taxiStopCount: 2,
        subtotalBase: 1500, subtotalMarkup: 0, subtotalCustomer: 1500, deliveryFee: 0, totalAmount: 1500, paymentMethod: 'CASH',
        taxiStops: { create: [{ sequence: 1, lat: 6.81, lng: -58.15, address: 'Bourda Market' }, { sequence: 2, lat: 6.815, lng: -58.14, address: 'Kitty Market' }] },
      },
      include: { taxiStops: { orderBy: { sequence: 'asc' } } },
    }));
    orderIds.push(ride.id);
    expect(ride.taxiStops.map((s) => [s.sequence, s.tenantId, s.status])).toEqual([[1, REVIEW, 'PENDING'], [2, REVIEW, 'PENDING']]);
  });

  it('a bound caller’s stop is stamped with its tenant; a stop naming a ride of ANOTHER tenant is refused', async () => {
    const mine = await taxiOrder(REVIEW, ids.reviewUser);
    expect((await runWithTenant(REVIEW, () => app.prisma.taxiTripStop.create({ data: stopData(mine.id, 1) }))).tenantId).toBe(REVIEW);
    const theirs = await taxiOrder(PRODUCTION, ids.prodUser);
    await expect(runWithTenant(REVIEW, () => app.prisma.taxiTripStop.create({ data: stopData(theirs.id, 1) }))).rejects.toThrow(/STA-1 lineage/);
  });

  it('an explicit tenant that disagrees with the ride, and a ride that does not exist, are refused', async () => {
    const ride = await taxiOrder(REVIEW, ids.reviewUser);
    await expect(stop(ride.id, 1, { tenantId: `other-${RUN}` })).rejects.toThrow(/STA-1 lineage|Foreign key/);
    await expect(stop(`no-such-ride-${RUN}`, 1)).rejects.toThrow(/STA-1 lineage|Foreign key/);
  });
});

describe('[TAXI multi-stop] the itinerary is frozen at request; progress is not', () => {
  it('refuses a change to the ride, the place in the order, the tenant or the id of a stop', async () => {
    const ride = await taxiOrder(PRODUCTION, ids.prodUser);
    const other = await taxiOrder(PRODUCTION, ids.prodUser);
    const s = await stop(ride.id, 1);
    const update = (data: Prisma.TaxiTripStopUncheckedUpdateInput) => system(() => app.prisma.taxiTripStop.update({ where: { id: s.id }, data }));
    await expect(update({ orderId: other.id })).rejects.toThrow(/is frozen/);
    await expect(update({ sequence: 2 })).rejects.toThrow(/is frozen/);
    await expect(update({ tenantId: REVIEW })).rejects.toThrow(/is frozen/);
    await expect(update({ id: `moved-${RUN}` })).rejects.toThrow(/is frozen/);
    const after = await system(() => app.prisma.taxiTripStop.findUniqueOrThrow({ where: { id: s.id } }));
    expect([after.orderId, after.sequence, after.tenantId]).toEqual([ride.id, 1, PRODUCTION]);
  });

  it('refuses a key rewrite that arrives by cascade from the ride', async () => {
    const ride = await taxiOrder(PRODUCTION, ids.prodUser);
    await stop(ride.id, 1);
    orderIds.push(`${ride.id}-x`); // cleaned up even if the rewrite were ever let through
    await expect(app.prisma.$executeRaw(Prisma.sql`UPDATE orders SET id = ${`${ride.id}-x`} WHERE id = ${ride.id}`)).rejects.toThrow(/is frozen/);
  });

  it('lets status, its timestamps, the skip reason, the actor and the evidence move', async () => {
    const ride = await taxiOrder(PRODUCTION, ids.prodUser);
    const s = await stop(ride.id, 1);
    const at = new Date();
    const moved = await system(() => app.prisma.taxiTripStop.update({
      where: { id: s.id },
      data: { status: 'ARRIVED', arrivedAt: at, legMeters: 1200, legSeconds: 240, actedBy: ids.prodUser, evidenceNote: 'gps 12 m' },
    }));
    expect([moved.status, moved.arrivedAt?.getTime()]).toEqual(['ARRIVED', at.getTime()]);
    const skipped = await system(() => app.prisma.taxiTripStop.update({
      where: { id: s.id }, data: { status: 'SKIPPED', skippedAt: new Date(), skipReason: 'Passenger changed plans' },
    }));
    expect([skipped.status, skipped.skipReason, skipped.sequence]).toEqual(['SKIPPED', 'Passenger changed plans', 1]);
  });
});

describe('[TAXI multi-stop] the shape of an itinerary, held by the database', () => {
  it('one stop per place in the order: (orderId, sequence) is unique', async () => {
    const ride = await taxiOrder(PRODUCTION, ids.prodUser);
    await stop(ride.id, 2);
    await expect(stop(ride.id, 2)).rejects.toThrow(/Unique constraint/);
  });

  it('sequence is 1..3 — intermediate stops only, three at most', async () => {
    const ride = await taxiOrder(PRODUCTION, ids.prodUser);
    for (const bad of [0, 4, -1]) await expect(stop(ride.id, bad)).rejects.toThrow(/taxi_trip_stops_sequence_check/);
    for (const good of [1, 2, 3]) expect((await stop(ride.id, good)).sequence).toBe(good);
  });

  it('a stop is a real place with an address the request schema would accept', async () => {
    const ride = await taxiOrder(PRODUCTION, ids.prodUser);
    await expect(stop(ride.id, 1, { lat: 90.5 })).rejects.toThrow(/taxi_trip_stops_lat_check/);
    await expect(stop(ride.id, 1, { lng: -180.5 })).rejects.toThrow(/taxi_trip_stops_lng_check/);
    await expect(stop(ride.id, 1, { address: '  x  ' })).rejects.toThrow(/taxi_trip_stops_address_check/);
    await expect(stop(ride.id, 1, { address: 'x'.repeat(201) })).rejects.toThrow(/taxi_trip_stops_address_check/);
    expect((await stop(ride.id, 1, { address: 'x'.repeat(200) })).address).toHaveLength(200);
  });

  it('a stop leaves with its ride: deleting the order cascades its stops, and no other ride’s', async () => {
    const ride = await taxiOrder(PRODUCTION, ids.prodUser);
    const neighbour = await taxiOrder(PRODUCTION, ids.prodUser);
    for (const n of [1, 2, 3]) await stop(ride.id, n);
    await stop(neighbour.id, 1);
    await system(() => app.prisma.order.delete({ where: { id: ride.id } }));
    expect(await system(() => app.prisma.taxiTripStop.count({ where: { orderId: ride.id } }))).toBe(0);
    expect(await system(() => app.prisma.taxiTripStop.count({ where: { orderId: neighbour.id } }))).toBe(1);
  });
});

describe('[TAXI multi-stop] the two inert header columns', () => {
  it('orders.taxiStopCount accepts NULL (every ride today) and 1..3, and refuses anything else on a new or updated row', async () => {
    expect((await taxiOrder(PRODUCTION, ids.prodUser)).taxiStopCount).toBeNull();
    for (const good of [1, 2, 3]) expect((await taxiOrder(PRODUCTION, ids.prodUser, { taxiStopCount: good })).taxiStopCount).toBe(good);
    for (const bad of [0, 4, -1]) {
      await expect(taxiOrder(PRODUCTION, ids.prodUser, { taxiStopCount: bad })).rejects.toThrow(/orders_taxi_stop_count_check/);
    }
    const ride = await taxiOrder(PRODUCTION, ids.prodUser);
    await expect(system(() => app.prisma.order.update({ where: { id: ride.id }, data: { taxiStopCount: 4 } })))
      .rejects.toThrow(/orders_taxi_stop_count_check/);
  });

  it('drivers.taxiStopsCapable is NOT NULL and defaults to false — no app is assumed to handle stops', async () => {
    const cols = await app.prisma.$queryRaw<{ table: string; column: string; nullable: string; def: string | null; type: string }[]>(Prisma.sql`
      SELECT table_name AS "table", column_name AS "column", is_nullable AS nullable, column_default AS def, data_type AS type
      FROM information_schema.columns
      WHERE table_schema = 'public' AND ((table_name = 'drivers' AND column_name = 'taxiStopsCapable') OR (table_name = 'orders' AND column_name = 'taxiStopCount'))
      ORDER BY 1`);
    expect(cols).toEqual([
      { table: 'drivers', column: 'taxiStopsCapable', nullable: 'NO', def: 'false', type: 'boolean' },
      { table: 'orders', column: 'taxiStopCount', nullable: 'YES', def: null, type: 'integer' },
    ]);
  });
});
