import type { PrismaClient } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import { classify, DEMO_PHONE_PREFIX, syntheticMarkersPresent } from '../modules/ops/purge-plan';

// [PLAT-3] The demo phone range (+592600…) is a live carrier range. The demo
// purge and the production census select by the synthetic marker ONLY; a phone
// prefix can narrow a plan's scope but never makes a row deletable. These read
// the exact predicates handed to the database. No database, synthetic ids.

const containsPhonePredicate = (where: unknown): boolean => JSON.stringify(where ?? {}).includes('"phone"');

describe('[PLAT-3] the synthetic marker is the only selector', () => {
  it('the production marker census counts marked rows only', async () => {
    const count = vi.fn(async () => 0);
    await syntheticMarkersPresent({ user: { count } } as unknown as PrismaClient);
    expect(count).toHaveBeenCalledTimes(1);
    expect(count).toHaveBeenCalledWith({ where: { syntheticRunId: { not: null } } });
  });

  it.each([undefined, { phonePrefix: `${DEMO_PHONE_PREFIX}91` }])('the purge candidates are selected by the marker; a scope only narrows (%j)', async (scope) => {
    const findMany = vi.fn(async (_args: { where: Record<string, unknown> }) => [] as Array<{ id: string; roles: string[] }>);
    const db = { user: { count: vi.fn(async () => 0), findMany }, $queryRaw: vi.fn(async () => []) };
    await classify(db as unknown as PrismaClient, scope);
    const candidates = findMany.mock.calls.map(([args]) => args.where).find((where) => !('roles' in where));
    expect(candidates, 'the candidate query').toBeDefined();
    expect(candidates).toMatchObject({ syntheticRunId: { not: null } });
    expect(candidates).not.toHaveProperty('OR');
    // the only phone predicate allowed is the scope's own narrowing
    if (scope) expect(candidates!['phone']).toEqual({ startsWith: scope.phonePrefix });
    else expect(containsPhonePredicate(candidates)).toBe(false);
  });
});
