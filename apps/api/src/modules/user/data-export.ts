import type { PrismaClient } from '@prisma/client';
import { AppError } from '../../utils/errors';
import { ACCOUNT_FIELDS, EXPORT_REGISTER, WITHHELD, WITHHELD_REASON_TEXT, type ExportEntry, type WithheldReason } from './data-export-register';

/**
 * [Row 331 · DSAR-ERASURE (b) · DPA right of access + portability] The person's
 * own data, every category the register names, read in pages. A category is
 * never cut short silently: past the per-category ceiling it is marked
 * `complete: false`, the file says `complete: false`, and the notice says so.
 */

/** Rows per category in one file; a category beyond this is marked incomplete, never silently cut. */
export const EXPORT_ROW_CEILING = 10_000;
const PAGE = 500;

type Row = Record<string, unknown>;
type Reader = { findMany(args: unknown): Promise<Row[]> };

function reader(db: PrismaClient, model: string): Reader {
  const delegate = (db as unknown as Record<string, Reader | undefined>)[model.charAt(0).toLowerCase() + model.slice(1)];
  if (!delegate?.findMany) throw new Error(`Export register names an unknown model ${model}`);
  return delegate;
}

/**
 * JSON has no BigInt: carry it as a decimal string (Dates and Decimals serialize themselves).
 * An empty (null) column is left out: most order columns belong to one kind of order, and
 * builds 9-12 hand the whole file to the share sheet as one text, so size matters.
 */
function portable(row: Row): Row {
  for (const [k, v] of Object.entries(row)) {
    if (v === null) delete row[k];
    else if (typeof v === 'bigint') row[k] = v.toString();
  }
  return row;
}

async function readCategory(db: PrismaClient, entry: ExportEntry, ids: string[], ceiling: number) {
  const match = { OR: entry.by.flatMap((column) => ids.map((id) => ({ [column]: id }))) };
  const select = Object.fromEntries([...entry.fields, entry.key].map((f) => [f, true]));
  const rows: Row[] = [];
  let after: unknown;
  for (;;) {
    const take = Math.min(PAGE, ceiling + 1 - rows.length);
    const page = await reader(db, entry.model).findMany({
      where: after === undefined ? match : { AND: [match, { [entry.key]: { gt: after } }] },
      select, orderBy: { [entry.key]: 'asc' }, take,
    });
    rows.push(...page);
    if (page.length < take || rows.length > ceiling) break;
    after = page[page.length - 1]![entry.key];
  }
  const complete = rows.length <= ceiling;
  const kept = rows.slice(0, ceiling).map((r) => {
    if (!entry.fields.includes(entry.key)) delete r[entry.key];
    return portable(r);
  });
  return { rows: kept, complete };
}

export const EXPORT_NOTICE =
  'This file is a copy of the personal data Swift holds about you, by category ("coverage" lists them all). '
  + 'Some things are left out on purpose, and "withheld" says what and why: codes and keys that protect your account; '
  + 'stored photos and document images, which are kept encrypted (contact Support to ask for a copy); details of other people; '
  + 'fraud-prevention and safety-investigation records; private notes staff wrote while handling a case; '
  + 'records of work done as Swift staff or for a business; and system bookkeeping.';

export const EXPORT_PARTIAL_NOTICE =
  'Some categories were too large for one file, so they stop early. Each is marked "complete": false in "coverage". '
  + 'Contact Support to get the rest.';

export async function exportPersonalData(db: PrismaClient, userId: string, options: { ceiling?: number } = {}) {
  const ceiling = options.ceiling ?? EXPORT_ROW_CEILING;
  const account = await db.user.findUnique({ where: { id: userId }, select: Object.fromEntries(ACCOUNT_FIELDS.map((f) => [f, true])) });
  if (!account) throw new AppError(404, 'NOT_FOUND', 'Account not found');

  const [rider, driver, provider] = await Promise.all([
    db.rider.findUnique({ where: { userId }, select: { id: true } }),
    db.driver.findUnique({ where: { userId }, select: { id: true } }),
    db.serviceProvider.findUnique({ where: { userId }, select: { id: true } }),
  ]);
  const via: Record<NonNullable<ExportEntry['via']>, string[]> = {
    rider: rider ? [rider.id] : [],
    driver: driver ? [driver.id] : [],
    provider: provider ? [provider.id] : [],
    mover: [rider?.id, driver?.id].filter((id): id is string => !!id),
  };

  const categories: Record<string, Row[]> = {};
  const coverage: Record<string, { rows: number; complete: boolean }> = {};
  for (const entry of EXPORT_REGISTER) {
    const ids = entry.via ? via[entry.via] : [userId];
    const { rows, complete } = ids.length ? await readCategory(db, entry, ids, ceiling) : { rows: [], complete: true };
    categories[entry.category] = rows;
    coverage[entry.category] = { rows: rows.length, complete };
  }
  const complete = Object.values(coverage).every((c) => c.complete);
  const reasons = [...new Set(Object.values(WITHHELD).map((w) => w.reason))] as WithheldReason[];

  return {
    exportedAt: new Date().toISOString(),
    complete,
    notice: complete ? EXPORT_NOTICE : `${EXPORT_PARTIAL_NOTICE} ${EXPORT_NOTICE}`,
    coverage,
    withheld: reasons.map((reason) => ({
      reason,
      what: WITHHELD_REASON_TEXT[reason],
      records: [...new Set(Object.values(WITHHELD).filter((w) => w.reason === reason).map((w) => w.note))],
    })),
    account: portable(account as Row),
    // The categories sit at the top level, as the keys builds 9-12 already share (addresses, orders, ratingsGiven, serviceJobs).
    ...categories,
  };
}
