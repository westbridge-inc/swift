import type { OrderStatus } from '@prisma/client';
import { ORDER_TRANSITIONS, RECOVERY_TRANSITIONS } from './order-status';

// ---------------------------------------------------------------------------
// [row 264 · AUD-L3a-003 / AUD-L7-005] THE DATABASE HOLDS THE ORDER MACHINE.
//
// Every legal order-status change is declared in order-status.ts: the forward
// machine (ORDER_TRANSITIONS) and the release edges (RECOVERY_TRANSITIONS).
// Until now only the application read them. A write that skipped the
// canonical seam (a blind updateMany, a hand-run SQL fix, a future caller
// that forgot the compare-and-set) could move an order anywhere, and the
// database said yes.
//
// The database now refuses any status change that is not one of those edges.
// The edge list in the trigger is GENERATED here, from the two tables, and is
// never written by hand: the migration carries this text, and the suite
// (order-status-db-guard.test.ts) proves the live database accepts exactly
// these pairs, all of them and nothing else. Adding an edge to order-status.ts
// without a migration that regenerates this function fails that suite.
//
// The same migration makes order_status_logs append-only in the database too:
// until now only the Prisma clients built in plugins/prisma.ts refused an
// update or delete, so any other connection could rewrite the trail behind
// cash disputes and claims. A row leaves only with its order (the foreign
// key cascade).
// ---------------------------------------------------------------------------

/** Which declared table an edge comes from. */
export type OrderStatusEdgeTable = 'FORWARD' | 'RECOVERY';

export interface OrderStatusEdge {
  from: OrderStatus;
  to: OrderStatus;
  table: OrderStatusEdgeTable;
}

/** Every status change the database accepts, in a stable order: the forward
 *  machine first, then the release edges, each keyed by target as declared. */
export function legalOrderStatusEdges(): OrderStatusEdge[] {
  const edges: OrderStatusEdge[] = [];
  const add = (declared: Record<OrderStatus, OrderStatus[]>, table: OrderStatusEdgeTable) => {
    for (const to of Object.keys(declared) as OrderStatus[]) {
      for (const from of declared[to]) {
        if (!edges.some((e) => e.from === from && e.to === to)) edges.push({ from, to, table });
      }
    }
  };
  add(ORDER_TRANSITIONS, 'FORWARD');
  add(RECOVERY_TRANSITIONS, 'RECOVERY');
  return edges;
}

export const ORDER_STATUS_GUARD = 'orders_status_transition_guard';
export const ORDER_STATUS_LOG_GUARD = 'order_status_logs_append_only';

const pair = (e: OrderStatusEdge) => `'${e.from}>${e.to}'`;

function edgeArray(table: OrderStatusEdgeTable): string {
  return legalOrderStatusEdges().filter((e) => e.table === table).map(pair).join(', ');
}

/** The function body of the order guard, as the database stores it (prosrc). */
export function orderStatusGuardBody(): string {
  return `
BEGIN
  IF (OLD."status"::text || '>' || NEW."status"::text) = ANY (ARRAY[${edgeArray('FORWARD')}]::text[]) THEN
    RETURN NEW;
  END IF;
  IF (OLD."status"::text || '>' || NEW."status"::text) = ANY (ARRAY[${edgeArray('RECOVERY')}]::text[]) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'ORDER_STATUS_ILLEGAL: order % cannot move from % to %: not an edge of ORDER_TRANSITIONS or RECOVERY_TRANSITIONS [row 264]',
    OLD."id", OLD."status", NEW."status" USING ERRCODE = 'check_violation';
END `;
}

/** The function body of the status-log guard (prosrc). A delete that arrives
 *  from inside another trigger (the cascade of the orders foreign key) for a log
 *  whose order is gone is the trail leaving with its order; anything else is refused. */
export function orderStatusLogGuardBody(): string {
  return `
BEGIN
  IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1
     AND NOT EXISTS (SELECT 1 FROM "orders" o WHERE o."id" = OLD."orderId") THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'ORDER_STATUS_LOG_APPEND_ONLY: order_status_logs row % is immutable evidence; % is refused (it leaves only with its order) [row 264]',
    OLD."id", TG_OP USING ERRCODE = 'check_violation';
END `;
}

/** The DDL the migration carries, statement by statement. */
export function orderStatusGuardDdl(): string[] {
  return [
    `CREATE OR REPLACE FUNCTION ${ORDER_STATUS_GUARD}() RETURNS trigger AS $$${orderStatusGuardBody()}$$ LANGUAGE plpgsql;`,
    `DROP TRIGGER IF EXISTS ${ORDER_STATUS_GUARD} ON "orders";`,
    `CREATE TRIGGER ${ORDER_STATUS_GUARD} BEFORE UPDATE ON "orders" FOR EACH ROW WHEN (OLD."status" IS DISTINCT FROM NEW."status") EXECUTE FUNCTION ${ORDER_STATUS_GUARD}();`,
    `CREATE OR REPLACE FUNCTION ${ORDER_STATUS_LOG_GUARD}() RETURNS trigger AS $$${orderStatusLogGuardBody()}$$ LANGUAGE plpgsql;`,
    `DROP TRIGGER IF EXISTS ${ORDER_STATUS_LOG_GUARD} ON "order_status_logs";`,
    `CREATE TRIGGER ${ORDER_STATUS_LOG_GUARD} BEFORE UPDATE OR DELETE ON "order_status_logs" FOR EACH ROW EXECUTE FUNCTION ${ORDER_STATUS_LOG_GUARD}();`,
  ];
}
