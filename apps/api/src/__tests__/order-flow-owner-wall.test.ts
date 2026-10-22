/**
 * [#1890 owner wall · COORD ruling 21 Oct 13:56Z] The order-flow sweeps ask the
 * inbox "is this person's notice already held?" before they re-send it. With
 * the owner wall ON (a walled request login, OWNER_RLS_BIND=1, system work on
 * its own bypass login) a plain read from anything but system work sees NONE
 * of a person's notices, so each such read names its system capability. A read
 * that sees nothing must never mean "not told yet, act": nothing is decided on
 * it (the grace runs from a decision row), and here it must not even re-send.
 *
 * Measured with the real sweep on a walled client of the app's own
 * construction (createScopedProcessClient on a per-suite walled login):
 *  - run as its job runs it (system work): one notice, no re-send while it is
 *    held, the order ends one grace after the warning;
 *  - run from a caller bound to a tenant only (where a plain read is blind):
 *    the held notice is still seen, so nothing is re-sent;
 *  - the harness is really walled: that same tenant-bound caller's plain read
 *    of the person's inbox sees nothing.
 * The order world (people, store, the real routes, the aged clock) is built on
 * the unwalled test login (helpers/order-walk-world.ts); only the sweep ticks
 * run walled, with the switches set around each tick.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import {
  ageWorld, buildWalkWorld, call, castWalk, placeCashOrder, releaseWorld, type Cast, type WalkWorld,
} from './helpers/order-walk-world';
import { testPrismaClient } from './helpers/test-prisma-client';
import { createTenantProbeLogins } from './helpers/tenant-probe-logins';
import { grantSuiteCapability } from '../lib/test-target-lock';
import { createScopedProcessClient, setSystemPrismaClient, systemPrismaClient } from '../plugins/prisma';
import { runAsSystem, runWithTenant } from '../plugins/tenant-context';
import { RIDERLESS_TOLD_OUTCOME, riderlessCutoffNoticeKey, sweepFoodAge } from '../modules/dispatch/rescue';
import { NotificationService, type NotificationPayload } from '../modules/notification/notification.service';

// [R048-001] creates only this suite's temporary request/system LOGIN roles, and grants the owner wall to one, by raw DDL.
grantSuiteCapability('ddl');

const MIN = 60_000;
const TEST_URL = process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift_test';
const WALL_KEYS = ['SYSTEM_DATABASE_URL', 'TENANT_UNSCOPED_ACCESS', 'TENANT_RLS_BIND', 'OWNER_RLS_BIND'] as const;
// The ruling's numbers, written here (not imported) so a changed constant reds this file.
const RIDERLESS_GRACE_MIN = 15;
const DEFAULT_PREP_PROMISE_MIN = 30;
// [O-3 · #2024] A store's Accept starts preparation: the accepted cash order waits at PREPARING.
const ACCEPTED_STATUS = 'PREPARING';
const FOOD_TOO_OLD_REASON = 'FOOD_TOO_OLD';

let w: WalkWorld;
let owner: PrismaClient;
let logins: Awaited<ReturnType<typeof createTenantProbeLogins>> | undefined;
/** The app's own client construction on the walled request login. */
let walledClient: PrismaClient;

/** Run one tick with the wall ON, exactly as production runs with it: the
 *  request login walled, OWNER_RLS_BIND=1, the tenant wall bound and strict,
 *  system work on the per-suite bypass login. */
async function walled<T>(fn: () => Promise<T>): Promise<T> {
  const prior = Object.fromEntries(WALL_KEYS.map((k) => [k, process.env[k]])) as Record<(typeof WALL_KEYS)[number], string | undefined>;
  process.env['SYSTEM_DATABASE_URL'] = logins!.systemUrl;
  process.env['TENANT_UNSCOPED_ACCESS'] = 'deny';
  process.env['TENANT_RLS_BIND'] = '1';
  process.env['OWNER_RLS_BIND'] = '1';
  try {
    return await fn();
  } finally {
    for (const k of WALL_KEYS) {
      if (prior[k] === undefined) delete process.env[k]; else process.env[k] = prior[k];
    }
  }
}
/** As jobs/queue.ts runs every job: named system work. */
const asJob = <T>(fn: () => Promise<T>) => runAsSystem('job:stale-movers:order-flow-owner-wall', fn);

/** Counts the sends of one notice kind (every send still really runs). */
class CountingNotices extends NotificationService {
  sends = 0;
  constructor(prisma: PrismaClient, io: WalkWorld['app']['io'], private readonly kind: string) { super(prisma, io); }
  override async send(payload: NotificationPayload): Promise<string> {
    if ((payload.data as Record<string, unknown> | undefined)?.['kind'] === this.kind) this.sends += 1;
    return super.send(payload);
  }
}

async function offline(cast: Cast) {
  for (const r of cast.riders) {
    await w.app.prisma.rider.update({ where: { id: r.riderId }, data: { isOnline: false, isAvailable: false } });
  }
}

beforeAll(async () => {
  w = await buildWalkWorld();
  owner = testPrismaClient(TEST_URL);
  logins = await createTenantProbeLogins(owner, TEST_URL);
  const requestRole = decodeURIComponent(new URL(logins.requestUrl).username);
  await owner.$executeRawUnsafe(`GRANT swift_owner_wall TO ${requestRole}`);
  walledClient = createScopedProcessClient({ datasourceUrl: logins.requestUrl });
}, 120_000);

afterAll(async () => {
  try {
    await walledClient?.$disconnect();
    if (logins) await walled(async () => { await systemPrismaClient()?.$disconnect().catch(() => {}); });
    setSystemPrismaClient(null);
    // Its stores, riders and unfinished orders must not outlive the suite.
    if (w) { await releaseWorld(w); await w.app.close(); }
  } finally {
    await logins?.cleanup();
    await owner?.$disconnect();
  }
});

describe('[OF-01 · #1890 wall ON] the riderless cutoff sees its own notice through the owner wall', () => {
  it('as its job runs it: told once, never re-sent while held, cancelled one grace after the warning; a tenant-bound tick re-sends nothing either', async () => {
    const cast = await castWalk(w, 1);
    await offline(cast);
    const { orderId } = await placeCashOrder(w, cast);
    expect(orderId).toBeTruthy();
    const id = orderId!;
    expect((await call(w, 'PUT', `/api/v1/vendor/orders/${id}/accept`, cast.vendorOwner.token)).statusCode).toBe(200);
    const order = await w.app.prisma.order.findUniqueOrThrow({ where: { id } });
    const prep = order.estimatedPrepTime && order.estimatedPrepTime > 0 ? order.estimatedPrepTime : DEFAULT_PREP_PROMISE_MIN;
    const notices = new CountingNotices(walledClient, w.app.io, 'riderless_cutoff');
    const deps = { prisma: walledClient, redis: w.app.redis, io: w.app.io, notifications: notices };
    const heldNotices = () => owner.notification.count({
      where: { userId: cast.customer.userId, dedupeKey: riderlessCutoffNoticeKey(id, order.riderAssignmentVersion ?? 0) },
    });

    // Just past the cutoff, walled, as the job: the warning is recorded and sent once.
    await ageWorld(w, (prep + 46) * MIN);
    await walled(() => asJob(() => sweepFoodAge(deps)));
    expect(notices.sends).toBe(1);
    expect(await heldNotices()).toBe(1);
    expect(await owner.algoDecision.count({ where: { subjectId: id, outcome: RIDERLESS_TOLD_OUTCOME } })).toBe(1);

    // Inside the grace, walled, as the job: the held notice is SEEN, so it is not re-sent.
    await ageWorld(w, 5 * MIN);
    await walled(() => asJob(() => sweepFoodAge(deps)));
    expect(notices.sends).toBe(1);

    // The harness is really walled: a caller bound to a tenant only reads none of the customer's notices plainly...
    const blindCount = await walled(() => runWithTenant(order.tenantId, () => walledClient.notification.count({ where: { userId: cast.customer.userId } })));
    expect(blindCount).toBe(0);
    // ...yet the cutoff's own read names its system capability: from that caller the held notice is still seen.
    await ageWorld(w, 5 * MIN);
    await walled(() => runWithTenant(order.tenantId, () => sweepFoodAge(deps)));
    expect(notices.sends).toBe(1);
    expect((await owner.order.findUniqueOrThrow({ where: { id } })).status).toBe(ACCEPTED_STATUS);

    // One grace after the warning, walled, as the job: cancelled; still exactly one warning.
    await ageWorld(w, (RIDERLESS_GRACE_MIN - 10) * MIN + 1_000);
    await walled(() => asJob(() => sweepFoodAge(deps)));
    const row = await owner.order.findUniqueOrThrow({ where: { id } });
    expect({ status: row.status, reason: row.cancellationReason }).toEqual({ status: 'CANCELLED', reason: FOOD_TOO_OLD_REASON });
    expect(notices.sends).toBe(1);
    expect(await heldNotices()).toBe(1);
  }, 300_000);
});
