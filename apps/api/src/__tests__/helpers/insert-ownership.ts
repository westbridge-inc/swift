import type { Prisma, PrismaClient } from '@prisma/client';
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
 * whose delegates are not the app client's, and some routes use an `$extends`
 * client of their own (the admin routes' tenant client). Every transaction the
 * app opens, and every client it extends once tracking starts, records its
 * notice and alert inserts too: start tracking before the routes register. */
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

  // A client the app derives from this one (a transaction's client, or an
  // `$extends` client such as the admin routes' tenant client) answers with
  // recording delegates too, and so do the clients derived from it.
  const wrapDelegate = (delegate: object, tracked: Record<string, unknown>) => new Proxy(delegate, {
    get: (target, key, receiver) => (typeof key === 'string' && key in tracked ? tracked[key] : Reflect.get(target, key, receiver)),
  });
  const runTracked = (run: (arg: unknown, options?: unknown) => Promise<unknown>) => (arg: unknown, options?: unknown) => (typeof arg === 'function'
    ? run((tx: Prisma.TransactionClient) => (arg as (client: Prisma.TransactionClient) => unknown)(trackClient(tx)), options)
    : run(arg, options));
  function trackClient<C extends object>(client: C): C {
    const base = client as unknown as Prisma.TransactionClient & { $transaction?: (arg: unknown, options?: unknown) => Promise<unknown>; $extends?: (...args: unknown[]) => object };
    const alertDelivery = wrapDelegate(base.alertDelivery, forAlerts(base.alertDelivery));
    const notification = wrapDelegate(base.notification, forNotices(base.notification));
    const transaction = base.$transaction ? runTracked(base.$transaction.bind(base)) : undefined;
    const extend = base.$extends ? (...args: unknown[]) => trackClient(base.$extends!(...args)) : undefined;
    return new Proxy(client, {
      get: (target, key, receiver) => {
        if (key === 'alertDelivery') return alertDelivery;
        if (key === 'notification') return notification;
        if (key === '$transaction' && transaction) return transaction;
        if (key === '$extends' && extend) return extend;
        return Reflect.get(target, key, receiver);
      },
    });
  }
  const transaction = prisma.$transaction.bind(prisma) as (arg: unknown, options?: unknown) => Promise<unknown>;
  spies.push(vi.spyOn(prisma, '$transaction').mockImplementation(runTracked(transaction) as unknown as typeof prisma.$transaction));
  const extend = prisma.$extends.bind(prisma) as (...args: unknown[]) => object;
  spies.push(vi.spyOn(prisma, '$extends').mockImplementation(((...args: unknown[]) => trackClient(extend(...args))) as unknown as typeof prisma.$extends));

  return { alertIds, notificationIds, restore: () => { for (const spy of spies) spy.mockRestore(); } };
}
