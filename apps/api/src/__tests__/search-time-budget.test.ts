import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { engine, guestSearchApp } from './helpers/guest-search';
import { SEARCH_DB_BUDGET_MS, SearchBudgetSpent, boundedRead, isOutOfTime } from '../modules/search/search-budget';
import { fillFromTiers, searchTiers } from '../modules/search/forgiving-text';

// ---------------------------------------------------------------------------
// [Review S2-1 · time bound] Customer search is bounded in TIME.
//
// Every forgiving database read on /search and /search/suggestions runs in a
// short transaction whose LOCAL statement timeout is what is left of the
// fill's budget. The database itself stops a read that outlives it; the door
// then answers with what the stricter tiers already found (200, never a 500),
// and the setting never reaches the next user of the pooled connection. Any
// other database error is still an error.
// ---------------------------------------------------------------------------

// The text Prisma gives a model query cancelled by statement_timeout (captured
// from Prisma 6 against Postgres 16), and a raw query's P2010 shape.
const MODEL_TIMEOUT = Object.assign(new Error(
  'Invalid `prisma.item.findMany()` invocation:\n\nError occurred during query execution:\n' +
  'ConnectorError(ConnectorError { user_facing_error: None, kind: QueryError(PostgresError { code: "57014", ' +
  'message: "canceling statement due to statement timeout", severity: "ERROR", detail: None, column: None, hint: None }), transient: false })',
), { name: 'PrismaClientUnknownRequestError' });
const RAW_TIMEOUT = Object.assign(new Error('Raw query failed. Code: `57014`. Message: `ERROR: canceling statement due to statement timeout`'), {
  name: 'PrismaClientKnownRequestError', code: 'P2010', meta: { code: '57014', message: 'ERROR: canceling statement due to statement timeout' },
});

describe('which errors mean "out of time"', () => {
  it('a cancelled statement (model or raw), a pool that cannot serve in time, a spent budget', () => {
    expect(isOutOfTime(MODEL_TIMEOUT)).toBe(true);
    expect(isOutOfTime(RAW_TIMEOUT)).toBe(true);
    expect(isOutOfTime(new Error('Transaction API error: Unable to start a transaction in the given time.'))).toBe(true);
    expect(isOutOfTime(new SearchBudgetSpent())).toBe(true);
  });
  it('nothing else', () => {
    expect(isOutOfTime(new Error('Can\'t reach database server at `db:5432`'))).toBe(false);
    expect(isOutOfTime(Object.assign(new Error('Unique constraint failed'), { code: 'P2002', meta: { target: ['id'] } }))).toBe(false);
    expect(isOutOfTime('57014')).toBe(false);
    expect(isOutOfTime(undefined)).toBe(false);
  });
});

// ── the fill itself (no database): the deadline is checked between reads ───
describe('fillFromTiers with a budget', () => {
  afterEach(() => { vi.restoreAllMocks(); });
  const tiers = searchTiers('pepper sauce', { text: ['name'], typoText: ['name'] });
  it('a deadline reached between reads ends the fill with what was found; the next read never starts', async () => {
    const realNow = Date.now.bind(Date);
    let skew = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => realNow() + skew);
    let n = 0;
    const read = vi.fn(async (_where: unknown, _take: number, _deadline: number) => {
      skew += 1_000; // each read "takes" a second
      n += 1;
      return [{ id: `row-${n}` }];
    });
    const onOutOfTime = vi.fn();
    expect(tiers.length).toBeGreaterThanOrEqual(3); // room for a third read
    const out = await fillFromTiers({ tiers, fetch: read, keep: (rows) => rows, limit: 50, budgetMs: 1_500, outOfTime: isOutOfTime, onOutOfTime });
    expect(read).toHaveBeenCalledTimes(2); // read 1 at t=0, read 2 at t=1s, none at t=2s
    expect(out.map((r) => r.id)).toEqual(['row-1', 'row-2']);
    expect(onOutOfTime).toHaveBeenCalledTimes(1);
    expect(read.mock.calls[0]![2]).toBeLessThanOrEqual(realNow() + 1_500); // the read is handed the fill's deadline
  });
  it('without a budget nothing changes: every tier is read', async () => {
    const read = vi.fn(async () => [] as Array<{ id: string }>);
    await fillFromTiers({ tiers, fetch: read, keep: (rows) => rows, limit: 50 });
    expect(read).toHaveBeenCalledTimes(tiers.length);
  });
});

// ── the real database: the timeout is set, it bites, and it stays local ────
describe('boundedRead on the real database', () => {
  let db: PrismaClient;
  const timeoutNow = async (client: Pick<PrismaClient, '$queryRaw'>) =>
    Number((await client.$queryRaw<Array<{ setting: string }>>`SELECT setting FROM pg_settings WHERE name = 'statement_timeout'`)[0]!.setting);
  beforeAll(() => {
    // ONE connection, so a setting that leaked out of the transaction would be
    // seen by the very next query.
    const url = new URL(process.env['DATABASE_URL']!);
    url.searchParams.set('connection_limit', '1');
    db = new PrismaClient({ datasourceUrl: url.toString() });
  });
  afterAll(async () => { await db.$disconnect(); });

  it('the read runs under a statement timeout no longer than what is left of the budget', async () => {
    const start = Date.now();
    const inside = await boundedRead(db, start + 800, (tx) => timeoutNow(tx));
    expect(inside).toBeGreaterThan(0);
    expect(inside).toBeLessThanOrEqual(800);
    const capped = await boundedRead(db, Date.now() + 60_000, (tx) => timeoutNow(tx));
    expect(capped).toBeLessThanOrEqual(SEARCH_DB_BUDGET_MS);
    expect(capped).toBeGreaterThan(0);
  });

  it('the database stops a read that outlives the deadline, and the error reads as out of time', async () => {
    const start = Date.now();
    const err = await boundedRead(db, start + 200, (tx) => tx.$queryRaw`SELECT pg_sleep(3)`).then(() => null, (e: unknown) => e);
    expect(err).not.toBeNull();
    expect(isOutOfTime(err)).toBe(true);
    expect(Date.now() - start).toBeLessThan(2_500); // stopped by the database, not after the full sleep
  });

  it('the setting never reaches the next query on the same connection', async () => {
    const before = await timeoutNow(db);
    await boundedRead(db, Date.now() + 500, (tx) => timeoutNow(tx));
    await boundedRead(db, Date.now() + 100, (tx) => tx.$queryRaw`SELECT pg_sleep(1)`).catch(() => undefined);
    expect(await timeoutNow(db)).toBe(before);
  });

  it('a budget already spent never starts the read', async () => {
    const read = vi.fn(async () => 1);
    await expect(boundedRead(db, Date.now() - 1, read)).rejects.toBeInstanceOf(SearchBudgetSpent);
    expect(read).not.toHaveBeenCalled();
  });
});

// ── the doors: every forgiving read is bounded; out of time is not an error ─
type Harness = Awaited<ReturnType<typeof guestSearchApp>>;
/** A read that matches TEXT (a forgiving tier), as opposed to a gate's lookup by id. */
const textReads = (fn: { mock: { calls: unknown[][] } }) =>
  fn.mock.calls.filter((c) => /"(contains|startsWith)"/.test(JSON.stringify((c[0] as { where?: unknown } | undefined)?.where ?? null))).length;
const apps: Harness[] = [];
afterEach(async () => { for (const h of apps.splice(0)) await h.app.close(); vi.unstubAllEnvs(); vi.restoreAllMocks(); engine.ready = false; });

/** Route every transaction through a recorder: which statement timeout each
 *  vendor/item read ran under, and an optional failure per read. */
async function recorded(fail?: (model: string, readNo: number) => unknown) {
  const h = await guestSearchApp();
  apps.push(h);
  const reads: Array<{ model: string; timeout: number | null }> = [];
  h.db.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => {
    let timeout: number | null = null;
    const tx = new Proxy(h.db as Record<string, unknown>, {
      get(target, key) {
        if (key === '$executeRaw') {
          return async (strings: TemplateStringsArray, ...values: unknown[]) => {
            if (strings.join('?').includes("set_config('statement_timeout'")) timeout = Number(values[0]);
            return 1;
          };
        }
        const model = target[key as string] as Record<string, (...a: unknown[]) => Promise<unknown>>;
        if (key !== 'item' && key !== 'vendor') return model;
        return {
          ...model,
          findMany: async (args: unknown) => {
            reads.push({ model: key, timeout });
            const failure = fail?.(key, reads.length);
            if (failure) throw failure;
            return model['findMany']!(args);
          },
        };
      },
    });
    return fn(tx);
  });
  return { h, reads };
}

describe('the search doors', () => {
  it('/search (database path): every store and dish read runs under the budget timeout', async () => {
    const { h, reads } = await recorded();
    const res = await h.app.inject({ url: '/api/v1/search?q=Pepper&limit=50' });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.items.length).toBeGreaterThan(0); // not vacuous
    expect(reads.length).toBeGreaterThan(0);
    // no text read went around the bounded transaction
    expect(reads.length).toBe(textReads(h.db.item.findMany) + textReads(h.db.vendor.findMany));
    for (const r of reads) {
      expect(r.timeout).toBeGreaterThan(0);
      expect(r.timeout).toBeLessThanOrEqual(SEARCH_DB_BUDGET_MS);
    }
  });

  it('/search/suggestions: every read runs under the budget timeout', async () => {
    const { h, reads } = await recorded();
    const res = await h.app.inject({ url: '/api/v1/search/suggestions?q=Pepper' });
    expect(res.statusCode).toBe(200);
    expect((res.json().data as unknown[]).length).toBeGreaterThan(0);
    expect(reads.map((r) => r.model).sort()).toEqual(expect.arrayContaining(['item', 'vendor']));
    expect(reads.length).toBe(textReads(h.db.item.findMany) + textReads(h.db.vendor.findMany));
    for (const r of reads) expect(r.timeout).toBeGreaterThan(0);
  });

  it('a read the database stops for time ends the fill with what the stricter tiers found (200, not 500)', async () => {
    // the dish door's FIRST read (exact words) answers; the next one is cancelled
    let itemReads = 0;
    const { h } = await recorded((model) => (model === 'item' && ++itemReads > 1 ? MODEL_TIMEOUT : undefined));
    const warn = vi.spyOn(h.app.log, 'warn');
    const res = await h.app.inject({ url: '/api/v1/search?q=Pepper%20dish&limit=50' });
    expect(res.statusCode).toBe(200);
    const ids = (res.json().data.items as Array<{ id: string }>).map((i) => i.id);
    expect(ids).toContain('item-public');
    expect(itemReads).toBeGreaterThan(1); // the cancelled read happened
    expect(JSON.stringify(warn.mock.calls)).not.toContain('Pepper'); // the log never carries the query
  });

  it('suggestions: a cancelled read still answers 200 with what was found', async () => {
    let vendorReads = 0;
    const { h } = await recorded((model) => (model === 'vendor' && ++vendorReads > 1 ? RAW_TIMEOUT : undefined));
    const res = await h.app.inject({ url: '/api/v1/search/suggestions?q=Pepper%20public' });
    expect(res.statusCode).toBe(200);
    expect(vendorReads).toBeGreaterThan(1);
    expect((res.json().data as Array<{ text: string }>).map((s) => s.text)).toContain('Pepper public');
  });

  it('any other database error is still an error, never an empty answer', async () => {
    const { h } = await recorded((model) => (model === 'item' ? new Error("Can't reach database server") : undefined));
    const res = await h.app.inject({ url: '/api/v1/search?q=Pepper&limit=50' });
    expect(res.statusCode).toBe(500);
  });

  it('a budget spent between reads ends the fill before the next read', async () => {
    let itemReads = 0;
    const realNow = Date.now.bind(Date);
    let skew = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => realNow() + skew);
    const { h } = await recorded((model) => {
      if (model === 'item' && ++itemReads === 1) skew = SEARCH_DB_BUDGET_MS + 1_000; // the first read "took" the whole budget
      return undefined;
    });
    const res = await h.app.inject({ url: '/api/v1/search?q=Pepper%20dish&limit=50' });
    expect(res.statusCode).toBe(200);
    expect(itemReads).toBe(1);
    expect((res.json().data.items as Array<{ id: string }>).map((i) => i.id)).toContain('item-public');
  });
});
