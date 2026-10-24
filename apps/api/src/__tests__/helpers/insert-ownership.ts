import { Prisma, type PrismaClient } from '@prisma/client';
import { nanoid } from 'nanoid';
import { vi } from 'vitest';

type Ids = Set<string>;
type Delegate = Record<string, (...args: never[]) => Promise<unknown>>;

/** The insert methods of one model delegate, each recording the ids it wrote.
 * RETURNING excludes skipDuplicates losers; failure never records an ID.
 * Explicit single IDs also work when the production caller selects no id.
 * An upsert records the id that holds after it (with `update: {}` callers that
 * is the row they wrote, or the one their own dedupe key already held). */
function trackedInserts(delegate: Delegate, ids: Ids, prefix: string) {
  const create = delegate['create']!.bind(delegate) as (args: { data: { id?: string } }) => Promise<unknown>;
  const createManyAndReturn = delegate['createManyAndReturn']!.bind(delegate) as (args: object) => Promise<Array<{ id: string }>>;
  const upsert = delegate['upsert']!.bind(delegate) as (args: { select?: Record<string, unknown> }) => Promise<{ id?: string } | null>;
  return {
    create: async (args: { data: { id?: string } }) => {
      const id = args.data.id ?? `${prefix}-${nanoid(16)}`;
      const result = await create({ ...args, data: { ...args.data, id } });
      ids.add(id);
      return result;
    },
    createMany: async (args: object) => {
      const rows = await createManyAndReturn({ ...args, select: { id: true } });
      for (const row of rows) ids.add(row.id);
      return { count: rows.length };
    },
    upsert: async (args: { select?: Record<string, unknown> }) => {
      const result = await upsert(args.select ? { ...args, select: { ...args.select, id: true } } : args);
      if (result?.id) ids.add(result.id);
      return result;
    },
  };
}

/** A run owns successful inserts on its client, never a before/after census.
 * Production writes many notices inside interactive transactions (the fee
 * demand, handover and pickup notices: lib/owner-wall-notices), on a tx client
 * whose delegates are not the app client's, so every transaction the app opens
 * hands its callback a client whose notice and alert inserts are recorded too. */
export function trackMessageInserts(prisma: PrismaClient) {
  const alertIds = new Set<string>();
  const notificationIds = new Set<string>();
  const forAlerts = (delegate: unknown) => trackedInserts(delegate as Delegate, alertIds, 'fixture-alert');
  const forNotices = (delegate: unknown) => trackedInserts(delegate as Delegate, notificationIds, 'fixture-notification');

  const spies: Array<{ mockRestore: () => void }> = [];
  const spyAll = (delegate: object, tracked: Record<string, unknown>) => {
    for (const [method, impl] of Object.entries(tracked)) {
      spies.push(vi.spyOn(delegate as Record<string, () => unknown>, method).mockImplementation(impl as () => unknown));
    }
  };
  spyAll(prisma.alertDelivery, forAlerts(prisma.alertDelivery));
  spyAll(prisma.notification, forNotices(prisma.notification));

  const trackTx = (tx: Prisma.TransactionClient): Prisma.TransactionClient => {
    const alerts = { ...forAlerts(tx.alertDelivery) };
    const notices = { ...forNotices(tx.notification) };
    const wrap = (delegate: object, tracked: Record<string, unknown>) => new Proxy(delegate, {
      get: (target, key, receiver) => (typeof key === 'string' && key in tracked ? tracked[key] : Reflect.get(target, key, receiver)),
    });
    const alertDelivery = wrap(tx.alertDelivery, alerts);
    const notification = wrap(tx.notification, notices);
    return new Proxy(tx, {
      get: (target, key, receiver) => (key === 'alertDelivery' ? alertDelivery : key === 'notification' ? notification : Reflect.get(target, key, receiver)),
    });
  };
  const transaction = prisma.$transaction.bind(prisma) as (arg: unknown, options?: unknown) => Promise<unknown>;
  spies.push(vi.spyOn(prisma, '$transaction').mockImplementation(((arg: unknown, options?: unknown) => (typeof arg === 'function'
    ? transaction((tx: Prisma.TransactionClient) => (arg as (client: Prisma.TransactionClient) => unknown)(trackTx(tx)), options)
    : transaction(arg, options))) as unknown as typeof prisma.$transaction));

  return { alertIds, notificationIds, restore: () => { for (const spy of spies) spy.mockRestore(); } };
}
