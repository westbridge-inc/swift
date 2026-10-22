import { hostname } from 'node:os';
import { randomInt } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { ownerRlsBindEnabled } from './owner-rls';

/**
 * [item 20 · owner wall · notifications] The inbox is walled to its person
 * (migration 20261018222000): only the person reads, updates or deletes a
 * notice, while ANYONE may hand a person one (policy notice_write: INSERT
 * WITH CHECK (true)). Almost every notice is written for someone else.
 *
 * Postgres checks the SELECT policy on INSERT ... RETURNING, and Prisma's
 * create and upsert always return the row: with the wall on, a create for
 * someone else would ERROR inside the caller's transaction. So every notice
 * is written here. With the wall ON (OWNER_RLS_BIND=1) it is one INSERT with
 * an app-generated id and no RETURNING (createMany): the same columns, the
 * same database defaults (createdAt, isRead), an id of the same cuid shape.
 * OFF it is exactly the create / upsert it replaced, so a dark wall changes no
 * query (the golden test writes every call-site class both ways and compares
 * the rows field by field). A census test refuses any other notice write.
 *
 * Reads and updates of SOMEONE ELSE'S notices: outside a transaction through
 * ownerWallSystem (lib/owner-rls); inside one, with the wall on, through the
 * narrow SECURITY DEFINER actions below (a transaction never changes
 * connection).
 */

type NoticeWriter = { notification: Pick<Prisma.TransactionClient['notification'], 'create' | 'createMany' | 'upsert'> };
type TxRaw = { $queryRaw<T = unknown>(query: TemplateStringsArray, ...values: unknown[]): Promise<T> };
/** What a notice write takes: exactly what `notification.create({ data })` took. */
export type NoticeData = Prisma.NotificationCreateManyInput;

const BASE = 36;
const BLOCK = BASE ** 4;
let counter = randomInt(BLOCK);
const pad = (n: number, width: number) => n.toString(BASE).padStart(width, '0').slice(-width);
const FINGERPRINT = (() => {
  const host = hostname();
  let sum = host.length + BASE;
  for (const ch of host) sum += ch.charCodeAt(0);
  return pad(process.pid, 2) + pad(sum, 2);
})();

/** A collision-resistant id of the shape Prisma's @default(cuid()) gives a
 *  notice: 'c' + time (8) + counter (4) + host fingerprint (4) + random (8),
 *  25 lowercase base-36 characters. */
export function noticeId(now: number = Date.now()): string {
  counter = (counter + 1) % BLOCK;
  return `c${pad(now, 8)}${pad(counter, 4)}${FINGERPRINT}${pad(randomInt(BLOCK), 4)}${pad(randomInt(BLOCK), 4)}`;
}

/**
 * Write one notice, for anyone, and return what the callers used of `create`:
 * the data written plus its id. A notice that collides on (userId, dedupeKey)
 * fails with Prisma's P2002, exactly as `create` did (inside a transaction it
 * aborts that transaction, exactly as before).
 */
export async function insertNoticeFor<D extends NoticeData>(db: NoticeWriter, data: D): Promise<D & { id: string }> {
  if (!ownerRlsBindEnabled()) {
    const created = await db.notification.create({ data, select: { id: true } });
    return { ...data, id: created.id };
  }
  const row = { ...data, id: data.id ?? noticeId() };
  await db.notification.createMany({ data: [row] });
  return row;
}

/**
 * The idempotent write the inbox outboxes and the fee demand used `upsert`
 * for (`update: {}`): write the notice, or leave the one already there as it
 * is, and return the id that holds. OFF it is that upsert. ON it is one
 * INSERT ... ON CONFLICT DO NOTHING; when it wrote nothing, the notice already
 * holding the dedupe key is read back through one narrow SECURITY DEFINER
 * action, inside the caller's transaction. As the upsert did:
 *  - keyed by id (`data.id` given): the given id, whether written now or
 *    earlier; a DIFFERENT notice already holding the person's dedupe key fails
 *    with P2002, as the unique index failed the upsert's insert;
 *  - keyed by (userId, dedupeKey) (no id): the new id, or the existing one.
 */
export async function upsertNoticeFor(db: NoticeWriter & TxRaw, data: NoticeData & { dedupeKey: string }): Promise<{ id: string }> {
  if (!ownerRlsBindEnabled()) {
    const where: Prisma.NotificationWhereUniqueInput = data.id !== undefined
      ? { id: data.id }
      : { userId_dedupeKey: { userId: data.userId, dedupeKey: data.dedupeKey } };
    return db.notification.upsert({ where, update: {}, create: data, select: { id: true } });
  }
  const id = data.id ?? noticeId();
  const { count } = await db.notification.createMany({ data: [{ ...data, id }], skipDuplicates: true });
  if (count === 1) return { id };
  const [held] = await db.$queryRaw<Array<{ id: string | null }>>`SELECT public.swift_owner_wall_notice_id(${data.userId}, ${data.dedupeKey}) AS id`;
  const existing = held?.id ?? null;
  if (data.id === undefined) {
    if (existing === null) throw new Error('notice write skipped, yet no notice holds its dedupe key');
    return { id: existing };
  }
  if (existing !== null && existing !== data.id) {
    throw new Prisma.PrismaClientKnownRequestError('Unique constraint failed on the fields: (`userId`,`dedupeKey`)', {
      code: 'P2002', clientVersion: Prisma.prismaVersion.client, meta: { modelName: 'Notification', target: ['userId', 'dedupeKey'] },
    });
  }
  return { id: data.id };
}

/** The narrow actions a transaction takes on SOMEONE ELSE'S notices
 *  (migration 20261018222000), each keyed by the person it acts on. The
 *  callers hold the authorization (the grant lock, the store owner, the
 *  projection); a census test pins them. */
export const OWNER_WALL_NOTICE_ACTIONS = [
  'swift_owner_wall_notice_id',
  'swift_owner_wall_pending_staff_invites',
  'swift_owner_wall_close_staff_invites',
  'swift_owner_wall_staff_invitees',
  'swift_owner_wall_public_phone_asked',
  'swift_owner_wall_erase_notices',
] as const;

/** One person's PENDING staff invites from one store (id + data). */
export async function pendingStaffInvitesOf(tx: TxRaw, userId: string, vendorId: string): Promise<Array<{ id: string; data: Prisma.JsonValue }>> {
  return tx.$queryRaw<Array<{ id: string; data: Prisma.JsonValue }>>`SELECT id, data FROM public.swift_owner_wall_pending_staff_invites(${userId}, ${vendorId})`;
}

/** Close one person's PENDING staff invites from one store (all but
 *  `exceptId`): read, readAt = decidedAt = `now`, state CLOSED. Returns how many. */
export async function closeStaffInvitesOf(tx: TxRaw, userId: string, vendorId: string, now: Date, exceptId?: string): Promise<number> {
  const [row] = await tx.$queryRaw<Array<{ n: number }>>`SELECT public.swift_owner_wall_close_staff_invites(${userId}, ${vendorId}, ${now.toISOString()}, ${exceptId ?? null}) AS n`;
  return row?.n ?? 0;
}

/** The people holding a PENDING staff invite from one store written since `since`. */
export async function staffInviteesOf(tx: TxRaw, vendorId: string, since: Date): Promise<string[]> {
  const rows = await tx.$queryRaw<Array<{ userId: string }>>`SELECT u AS "userId" FROM public.swift_owner_wall_staff_invitees(${vendorId}, ${since.toISOString()}) AS u`;
  return rows.map((r) => r.userId);
}

/** Has this person already been asked to publish a callable number for this store? */
export async function publicPhoneAsked(tx: TxRaw, userId: string, vendorId: string): Promise<boolean> {
  const [row] = await tx.$queryRaw<Array<{ asked: boolean }>>`SELECT public.swift_owner_wall_public_phone_asked(${userId}, ${vendorId}) AS asked`;
  return row?.asked === true;
}

/** [#1905 erasure] Remove every notice of a person being erased, from inside the erasure transaction (which
 *  holds their users row lock), whoever runs it: the person, an admin closing the account, the retry sweep.
 *  Returns how many. [row 622] The action refuses (throws) unless the account carries the erasure tombstone,
 *  which the closure writes first. */
export async function eraseNoticesOf(tx: TxRaw, userId: string): Promise<number> {
  const [row] = await tx.$queryRaw<Array<{ n: number }>>`SELECT public.swift_owner_wall_erase_notices(${userId}) AS n`;
  return row?.n ?? 0;
}
