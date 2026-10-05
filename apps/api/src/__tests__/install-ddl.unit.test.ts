import type { Prisma, PrismaClient } from '@prisma/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { installDdl } from './helpers/install-ddl';

type Operation = { attempt: number; kind: 'execute' | 'query'; sql: string };
type Failure = { attempt: number; sql: string; error: unknown };

function harness(options: {
  rows?: Array<{ relname: string; enabled: boolean; forced: boolean }>;
  failures?: Failure[];
} = {}) {
  const operations: Operation[] = [];
  const rootExecute = vi.fn();
  const rootQuery = vi.fn();
  let attempt = 0;
  const failures = [...(options.failures ?? [])];

  const transaction = vi.fn(async (
    body: (tx: Prisma.TransactionClient) => Promise<unknown>,
  ) => {
    attempt += 1;
    const tx = {
      $executeRawUnsafe: vi.fn(async (sql: string) => {
        operations.push({ attempt, kind: 'execute', sql });
        const failure = failures.find((entry) => entry.attempt === attempt && entry.sql === sql);
        if (failure) throw failure.error;
        return 0;
      }),
      $queryRawUnsafe: vi.fn(async (sql: string) => {
        operations.push({ attempt, kind: 'query', sql });
        return options.rows ?? [];
      }),
    } as unknown as Prisma.TransactionClient;
    return body(tx);
  });

  const prisma = {
    $executeRawUnsafe: rootExecute,
    $queryRawUnsafe: rootQuery,
    $transaction: transaction,
  } as unknown as PrismaClient;

  return { prisma, operations, rootExecute, rootQuery, transaction };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('installDdl connection and retry contract', () => {
  it('runs timeout, xact lock, catalog read, and DDL on one transaction client in order', async () => {
    const subject = harness();

    await installDdl(subject.prisma, ['DDL ONE']);

    expect(subject.rootExecute).not.toHaveBeenCalled();
    expect(subject.rootQuery).not.toHaveBeenCalled();
    expect(subject.operations).toHaveLength(4);
    expect(subject.operations[0]?.sql).toBe("SET LOCAL lock_timeout = '4s'");
    expect(subject.operations[1]?.sql).toBe('SELECT pg_advisory_xact_lock(7741990001)');
    expect(subject.operations[2]).toMatchObject({ kind: 'query', attempt: 1 });
    expect(subject.operations[2]?.sql).toContain('FROM pg_class');
    expect(subject.operations[3]).toEqual({ attempt: 1, kind: 'execute', sql: 'DDL ONE' });
    expect(subject.transaction).toHaveBeenCalledWith(expect.any(Function), {
      maxWait: 10_000,
      timeout: 90_000,
    });
    expect(subject.operations.map(({ sql }) => sql).join('\n')).not.toMatch(/pg_advisory_unlock|SET lock_timeout = DEFAULT/);
  });

  it('uses a fresh transaction-scoped lock for successive batches', async () => {
    const subject = harness();

    await installDdl(subject.prisma, ['DDL ONE']);
    await installDdl(subject.prisma, ['DDL TWO']);

    expect(subject.transaction).toHaveBeenCalledTimes(2);
    expect(subject.operations.filter(({ sql }) => sql.includes('pg_advisory_xact_lock')))
      .toEqual([
        { attempt: 1, kind: 'execute', sql: 'SELECT pg_advisory_xact_lock(7741990001)' },
        { attempt: 2, kind: 'execute', sql: 'SELECT pg_advisory_xact_lock(7741990001)' },
      ]);
  });

  it.each(['55P03', '40P01', 'P2034'])('restarts the entire batch after retryable %s', async (code) => {
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((callback: () => void) => {
      callback();
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout);
    const subject = harness({
      failures: [{ attempt: 1, sql: 'DDL TWO', error: { meta: { code } } }],
    });

    await installDdl(subject.prisma, ['DDL ONE', 'DDL TWO']);

    expect(subject.transaction).toHaveBeenCalledTimes(2);
    expect(subject.operations.filter(({ sql }) => sql === 'DDL ONE').map(({ attempt }) => attempt))
      .toEqual([1, 2]);
    expect(subject.operations.filter(({ sql }) => sql === 'DDL TWO').map(({ attempt }) => attempt))
      .toEqual([1, 2]);
  });

  it('fails an unknown error immediately', async () => {
    const failure = new Error('invalid DDL');
    const subject = harness({ failures: [{ attempt: 1, sql: 'DDL ONE', error: failure }] });

    await expect(installDdl(subject.prisma, ['DDL ONE'])).rejects.toBe(failure);
    expect(subject.transaction).toHaveBeenCalledTimes(1);
  });

  it('stops after five failed atomic attempts', async () => {
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((callback: () => void) => {
      callback();
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout);
    const failure = { code: '55P03' };
    const subject = harness({
      failures: [1, 2, 3, 4, 5].map((attempt) => ({ attempt, sql: 'DDL ONE', error: failure })),
    });

    await expect(installDdl(subject.prisma, ['DDL ONE'])).rejects.toBe(failure);
    expect(subject.transaction).toHaveBeenCalledTimes(5);
  });

  it('preserves the ENABLE/FORCE skip and UNDOES_RLS exception', async () => {
    const rows = [{ relname: 'items', enabled: true, forced: true }];
    const skipped = harness({ rows });
    await installDdl(skipped.prisma, [
      'ALTER TABLE items ENABLE ROW LEVEL SECURITY',
      'ALTER TABLE items FORCE ROW LEVEL SECURITY',
      'DDL ONE',
    ]);
    expect(skipped.operations.filter(({ sql }) => sql.startsWith('ALTER TABLE'))).toEqual([]);
    expect(skipped.operations.some(({ sql }) => sql === 'DDL ONE')).toBe(true);

    const undone = harness({ rows });
    await installDdl(undone.prisma, [
      'ALTER TABLE items ENABLE ROW LEVEL SECURITY',
      'ALTER TABLE items DISABLE ROW LEVEL SECURITY',
    ]);
    expect(undone.operations.filter(({ sql }) => sql.startsWith('ALTER TABLE')).map(({ sql }) => sql))
      .toEqual([
        'ALTER TABLE items ENABLE ROW LEVEL SECURITY',
        'ALTER TABLE items DISABLE ROW LEVEL SECURITY',
      ]);
  });
});
