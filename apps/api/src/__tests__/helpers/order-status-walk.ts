import type { OrderStatus, Prisma } from '@prisma/client';
import { ORDER_TRANSITIONS, RECOVERY_TRANSITIONS, TERMINAL_ORDER_STATUSES } from '../../modules/order/order-status';

// ---------------------------------------------------------------------------
// [row 264] The database refuses an order-status change that is not a declared
// edge of order-status.ts (ORDER_TRANSITIONS or RECOVERY_TRANSITIONS). A test
// that needs an order in some status either CREATES it there (an INSERT is not
// judged) or WALKS it there along declared edges, the way production would
// have moved it. There is no third way: a fixture that jumped an order across
// the machine was testing a state production can never reach.
// ---------------------------------------------------------------------------

/** The shortest declared path from `from` to `to` (the statuses after `from`), or null when none exists. */
export function declaredStatusPath(from: OrderStatus, to: OrderStatus): OrderStatus[] | null {
  if (from === to) return [];
  const next = new Map<OrderStatus, OrderStatus[]>();
  for (const table of [ORDER_TRANSITIONS, RECOVERY_TRANSITIONS]) {
    for (const target of Object.keys(table) as OrderStatus[]) {
      for (const source of table[target]) next.set(source, [...(next.get(source) ?? []), target]);
    }
  }
  const previous = new Map<OrderStatus, OrderStatus>();
  const queue: OrderStatus[] = [from];
  while (queue.length) {
    const at = queue.shift()!;
    for (const step of next.get(at) ?? []) {
      if (step === from || previous.has(step)) continue;
      previous.set(step, at);
      if (step === to) {
        const path: OrderStatus[] = [to];
        for (let s = at; s !== from; s = previous.get(s)!) path.unshift(s);
        return path;
      }
      queue.push(step);
    }
  }
  return null;
}

/** Move an order to `to` along declared edges, writing `data` with every step (so a mover or a
 *  timestamp the target needs is already there on the way). */
export async function walkOrderStatus(
  db: Prisma.TransactionClient,
  id: string,
  to: OrderStatus,
  data: Omit<Prisma.OrderUncheckedUpdateInput, 'status'> = {},
): Promise<void> {
  const { status } = await db.order.findUniqueOrThrow({ where: { id }, select: { status: true } });
  const path = declaredStatusPath(status, to);
  if (!path) throw new Error(`No declared path from ${status} to ${to} (order-status.ts): create the fixture order in ${to} instead.`);
  for (const step of path.length ? path : [to]) await db.order.update({ where: { id }, data: { ...data, status: step } });
}

/** Where a test retires its live orders: CANCELLED when the machine allows it, else the nearest
 *  terminal the order can still reach (an order in a mover's custody cannot be cancelled). */
const RETIREMENT = ['CANCELLED', 'FAILED', 'RETURNED', 'DELIVERED', 'COMPLETED'] as const satisfies readonly OrderStatus[];

/** Retire every live order matching `where` along declared edges (test cleanup). */
export async function retireLiveOrders(
  db: Prisma.TransactionClient,
  where: Prisma.OrderWhereInput,
  data: Omit<Prisma.OrderUncheckedUpdateInput, 'status'> = {},
  prefer: readonly OrderStatus[] = RETIREMENT,
): Promise<number> {
  const live = await db.order.findMany({ where: { ...where, status: { notIn: [...TERMINAL_ORDER_STATUSES] } }, select: { id: true, status: true } });
  for (const order of live) {
    const target = prefer.find((t) => declaredStatusPath(order.status, t) !== null);
    if (!target) throw new Error(`Order ${order.id} in ${order.status} can reach no terminal status (order-status.ts).`);
    await walkOrderStatus(db, order.id, target, data);
  }
  return live.length;
}
