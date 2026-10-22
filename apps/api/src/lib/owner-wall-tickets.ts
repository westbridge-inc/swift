import type { Prisma } from '@prisma/client';
import { ownerRlsBindEnabled } from './owner-rls';
import { noticeId } from './owner-wall-notices';

/**
 * [item 20 · owner wall · support tickets] A ticket is walled to its person
 * (migration 20261018223000), like the inbox: only the person reads, updates
 * or deletes it through a request login, while a case may be OPENED for a
 * person (policy ticket_write: INSERT WITH CHECK (true)). Support staff work
 * the queue through a named capability (admin routes).
 *
 * The person opens their own tickets with a plain create (it returns their own
 * row). The one case opened FOR someone else (the MMG store-silent sweep
 * opens it for the customer, inside its transaction) is written here: with the
 * wall ON one INSERT with an app-generated id of the same cuid shape and no
 * RETURNING (Postgres checks the SELECT policy on RETURNING); OFF exactly the
 * create it replaced. A census test (owner-wall-support-tickets) refuses any
 * other cross-person ticket write.
 */

type TicketWriter = { supportTicket: Pick<Prisma.TransactionClient['supportTicket'], 'create' | 'createMany'> };
type TxRaw = { $queryRaw<T = unknown>(query: TemplateStringsArray, ...values: unknown[]): Promise<T> };
/** What a ticket write takes: exactly what `supportTicket.create({ data })` took. */
export type TicketData = Prisma.SupportTicketCreateManyInput;

/** Open one ticket FOR a person and return what the caller used of `create`:
 *  the data written plus its id. */
export async function insertTicketFor<D extends TicketData>(db: TicketWriter, data: D): Promise<D & { id: string }> {
  if (!ownerRlsBindEnabled()) {
    const created = await db.supportTicket.create({ data, select: { id: true } });
    return { ...data, id: created.id };
  }
  const row = { ...data, id: data.id ?? noticeId() };
  await db.supportTicket.createMany({ data: [row] });
  return row;
}

/** The narrow actions a transaction takes on SOMEONE ELSE'S ticket (migration
 *  20261018223000), keyed by the order and the case's subject. The callers
 *  hold the authorization (the order row lock, the store's own order); a
 *  census test pins them. */
export const OWNER_WALL_TICKET_ACTIONS = ['swift_owner_wall_order_case_exists', 'swift_owner_wall_close_order_case'] as const;

/** Is a PAYMENT case with this subject already open for the order (any status)? */
export async function orderCaseExists(tx: TxRaw, orderId: string, subject: string): Promise<boolean> {
  const [row] = await tx.$queryRaw<Array<{ open: boolean }>>`SELECT public.swift_owner_wall_order_case_exists(${orderId}, ${subject}) AS open`;
  return row?.open === true;
}

/** Close the order's still-open PAYMENT case with this subject (RESOLVED,
 *  ACTION_TAKEN, the note, resolvedAt = `resolvedAt`). Returns how many. */
export async function closeOrderCase(tx: TxRaw, orderId: string, subject: string, note: string, resolvedAt: Date): Promise<number> {
  // updatedAt is stamped the way Prisma stamps @updatedAt: the app's clock, now.
  const [row] = await tx.$queryRaw<Array<{ n: number }>>`SELECT public.swift_owner_wall_close_order_case(${orderId}, ${subject}, ${note}, ${resolvedAt.toISOString()}, ${new Date().toISOString()}) AS n`;
  return row?.n ?? 0;
}
