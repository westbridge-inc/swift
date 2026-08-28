import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { nanoid } from 'nanoid';
import { ALGO_DEFAULTS, algoConfig, algoValue, invalidateAlgoConfig } from '../modules/algo/algo-config';

// ---------------------------------------------------------------------------
// [ALGO Band 0.2] THE VERSIONED TUNABLE STORE.
//
// The platform's algorithm dials are bare `const`s scattered across two dozen
// files. That is fine until someone asks "what was the cap when this ran?" —
// and the only honest answer is "whatever the constant said when that commit
// was deployed", which nobody can reconstruct a year later.
//
// The whole design rests on ONE property, and it is the property this file
// grades hardest: AN EMPTY TABLE MUST BEHAVE EXACTLY AS TODAY. Every default
// lives in code, so moving a constant onto this store is a no-behaviour-change
// edit — and if that is not true, every future move silently changes something.
//
// The second property is that a value is RE-EXPLAINABLE. Rows are immutable
// versions rather than editable settings: changing a value inserts version
// N+1, the value in force is the highest version, and a decision stamped with
// version 3 can still be read against the row that produced it after 4 lands.
// ---------------------------------------------------------------------------

let prisma: PrismaClient;
// A FRESH TENANT PER TEST. Rows are immutable versions, so reusing a tenant
// across tests makes them collide on (tenantId, key, version) — which is the
// store working, not a bug, but it would couple every test to every other.
let TENANT = '';
let OTHER_TENANT = '';
const createdIds: string[] = [];

async function put(key: string, value: unknown, version: number, tenantId = TENANT) {
  const row = await prisma.algoConfig.create({
    data: { tenantId, key, value: value as never, version, updatedBy: 'algo-config.test' },
  });
  createdIds.push(row.id);
  invalidateAlgoConfig(tenantId, key);
  return row;
}

beforeAll(async () => {
  process.env['NODE_ENV'] = 'development';
  prisma = new PrismaClient();
  await prisma.$connect();
});

beforeEach(() => {
  invalidateAlgoConfig();
  const id = nanoid(8);
  TENANT = `algo-cfg-${id}`;
  OTHER_TENANT = `algo-cfg-other-${id}`;
});

afterAll(async () => {
  if (createdIds.length) await prisma.algoConfig.deleteMany({ where: { id: { in: createdIds } } });
  await prisma.$disconnect();
});

describe('an empty table behaves exactly as today', () => {
  it('every declared key resolves to its code default at version 0', async () => {
    // The load-bearing assertion of the whole band. If a key ever resolves to
    // something other than its default with no row present, then every
    // constant moved onto this store has silently changed value.
    for (const key of Object.keys(ALGO_DEFAULTS) as Array<keyof typeof ALGO_DEFAULTS>) {
      const resolved = await algoConfig(prisma, key, TENANT);
      expect(resolved.value, `${key} must fall back to its code default`).toEqual(ALGO_DEFAULTS[key]);
      expect(resolved.version, `${key} default must report version 0`).toBe(0);
      expect(resolved.source).toBe('default');
    }
  });

  it('the batching numbers are the ones the scan already ran on', async () => {
    // Pinned literally, not derived from ALGO_DEFAULTS: deriving them would
    // make this test agree with any value someone typed there. These are the
    // constants that were in shadow-scan.ts before the move.
    expect(ALGO_DEFAULTS['batching.evalCap']).toBe(200);
    expect(ALGO_DEFAULTS['batching.pairDedupMinutes']).toBe(30);
  });
});

describe('a configured value wins, and says which version it was', () => {
  it('returns the row and its version', async () => {
    await put('batching.evalCap', 50, 1);

    const resolved = await algoConfig(prisma, 'batching.evalCap', TENANT);

    expect(resolved.value).toBe(50);
    expect(resolved.version).toBe(1);
    expect(resolved.source).toBe('config');
  });

  it('the HIGHEST version is the one in force, whatever order rows arrive in', async () => {
    // Written out of order deliberately: "in force" must be a property of the
    // version number, not of insertion or of `createdAt`.
    await put('batching.pairDedupMinutes', 11, 3);
    await put('batching.pairDedupMinutes', 99, 1);
    await put('batching.pairDedupMinutes', 22, 2);

    expect(await algoValue(prisma, 'batching.pairDedupMinutes', TENANT)).toBe(11);
  });

  it('an older version stays readable after a newer one lands', async () => {
    // This is what makes a decision re-explainable: version 1 is not edited
    // away when version 2 arrives, so a record stamped with 1 can still be
    // read against the row that produced it.
    await put('batching.evalCap', 7, 1);
    await put('batching.evalCap', 8, 2);

    const v1 = await prisma.algoConfig.findFirst({ where: { tenantId: TENANT, key: 'batching.evalCap', version: 1 } });
    expect(v1?.value).toBe(7);
    expect(await algoValue(prisma, 'batching.evalCap', TENANT)).toBe(8);
  });

  it('the same version cannot be written twice', async () => {
    // A version is written once and never rewritten, so a concurrent double
    // write loses loudly instead of silently replacing an audited value.
    await put('batching.evalCap', 1, 1);
    await expect(put('batching.evalCap', 2, 1)).rejects.toThrow();
  });
});

describe('degraded config falls back, never to zero', () => {
  it('a row whose value is JSON null is treated as absent', async () => {
    // A row that says nothing is not a configured value. Handing an algorithm
    // a null where it expects a number is how a cap becomes 0 and a scan
    // evaluates nothing.
    await put('batching.evalCap', null, 1);

    const resolved = await algoConfig(prisma, 'batching.evalCap', TENANT);

    expect(resolved.value).toBe(ALGO_DEFAULTS['batching.evalCap']);
    expect(resolved.source).toBe('default');
  });

  it('a failing read returns the code default instead of throwing', async () => {
    // An algorithm must never fail because a dial could not be read. Yesterday's
    // behaviour beats no behaviour [L6].
    const broken = {
      algoConfig: { findFirst: async () => { throw new Error('connection lost'); } },
    } as unknown as PrismaClient;

    const resolved = await algoConfig(broken, 'batching.evalCap', TENANT);

    expect(resolved.value).toBe(200);
    expect(resolved.source).toBe('default');
  });
});

describe('one operator cannot read another operator dials', () => {
  it('a value set for one tenant does not resolve for another', async () => {
    await put('batching.evalCap', 5, 1, TENANT);

    expect(await algoValue(prisma, 'batching.evalCap', TENANT)).toBe(5);
    expect(
      await algoValue(prisma, 'batching.evalCap', OTHER_TENANT),
      'another operator must see its own default, never this tenant\'s dial',
    ).toBe(ALGO_DEFAULTS['batching.evalCap']);
  });

  it('the cache is keyed by tenant as well as key', async () => {
    // A cache keyed on the key alone would serve the first tenant's value to
    // everyone for the whole TTL — the exact shape of a cross-tenant leak.
    await put('batching.evalCap', 5, 1, TENANT);
    await algoValue(prisma, 'batching.evalCap', TENANT); // warm
    expect(await algoValue(prisma, 'batching.evalCap', OTHER_TENANT)).toBe(ALGO_DEFAULTS['batching.evalCap']);
  });
});

describe('the cache can be dropped', () => {
  it('a new version is seen after invalidation', async () => {
    await put('batching.evalCap', 3, 1);
    expect(await algoValue(prisma, 'batching.evalCap', TENANT)).toBe(3);

    await put('batching.evalCap', 4, 2); // put() invalidates

    expect(await algoValue(prisma, 'batching.evalCap', TENANT)).toBe(4);
  });

  it('the value IS cached — a read after a silent write still returns the old one', async () => {
    // Guards the guard: if nothing were cached, the invalidation test above
    // would pass without proving anything.
    await put('batching.evalCap', 3, 1);
    await algoValue(prisma, 'batching.evalCap', TENANT); // warm the cache

    const row = await prisma.algoConfig.create({
      data: { tenantId: TENANT, key: 'batching.evalCap', value: 4 as never, version: 2, updatedBy: 'silent' },
    });
    createdIds.push(row.id);

    expect(await algoValue(prisma, 'batching.evalCap', TENANT), 'no invalidation → the cached value stands').toBe(3);
    invalidateAlgoConfig(TENANT, 'batching.evalCap');
    expect(await algoValue(prisma, 'batching.evalCap', TENANT)).toBe(4);
  });
});
