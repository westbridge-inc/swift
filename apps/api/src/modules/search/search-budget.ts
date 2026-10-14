import type { Prisma, PrismaClient } from '@prisma/client';

// ---------------------------------------------------------------------------
// [Review S2-1 · time bound] A customer search is bounded in TIME, not only in
// rows.
//
// The forgiving tiers (forgiving-text.ts) read pieces of names and
// descriptions; the trigram indexes make that cheap, but a public door with
// no ceiling on a single read's cost is still one bad query away from holding
// the database. A per-route request limit would not fix it fairly: guests
// behind one carrier NAT share one rate-limit bucket (utils/rate-limit-key.ts),
// so a tight limit throttles honest customers together.
//
// Instead every forgiving search read runs in a short transaction whose
// statement timeout is what is left of the fill's budget. A read that runs
// out of time is cancelled by the database itself (not merely abandoned by
// the API while it keeps running); the fill then answers with what the
// stricter tiers already found. The setting is LOCAL to that transaction, so
// it never reaches the next user of the pooled connection.
// ---------------------------------------------------------------------------

/** Wall-clock budget for one forgiving fill (one door of one request). */
export const SEARCH_DB_BUDGET_MS = 2_500;

/** The fill's budget was spent before this read could start. */
export class SearchBudgetSpent extends Error {
  constructor() {
    super('search time budget spent');
    this.name = 'SearchBudgetSpent';
  }
}

// Postgres 57014 (query_canceled by statement_timeout) arrives as P2010 with
// meta.code on a raw query and as an unknown-request error carrying the code
// and text on a model query; a pool that cannot hand out a connection before
// the budget ends is the same outcome for a search.
const OUT_OF_TIME_TEXT = /canceling statement due to statement timeout|code: "57014"|Unable to start a transaction in the given time/;

/** True for the errors that mean "this search read ran out of time". */
export function isOutOfTime(err: unknown): boolean {
  if (err instanceof SearchBudgetSpent) return true;
  if (!(err instanceof Error)) return false;
  const meta = (err as { meta?: { code?: unknown } }).meta;
  return meta?.code === '57014' || OUT_OF_TIME_TEXT.test(err.message);
}

/** Run one search read with the database told to stop it at `deadline` (epoch ms). */
export function boundedRead<T>(
  prisma: Pick<PrismaClient, '$transaction'>,
  deadline: number,
  read: (db: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  const left = () => Math.min(Math.floor(deadline - Date.now()), SEARCH_DB_BUDGET_MS);
  return prisma.$transaction(async (tx) => {
    const ms = left();
    if (!(ms > 0)) throw new SearchBudgetSpent();
    await tx.$executeRaw`SELECT set_config('statement_timeout', ${String(ms)}, true)`;
    return read(tx);
  }, { maxWait: Math.max(left(), 1), timeout: SEARCH_DB_BUDGET_MS + 2_000 });
}
