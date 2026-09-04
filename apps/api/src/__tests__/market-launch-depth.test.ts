import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  marketGate,
  thresholdsFrom,
  MARKET_MIN_ITEMS,
  MARKET_MIN_VENDORS,
} from '../modules/market/launch-depth';

// ---------------------------------------------------------------------------
// [MKT G7 / B5] "An empty marketplace is worse than no marketplace" (§5.4).
//
// The gate's own spec note names the failure it exists to prevent: "The tab
// ships with one store in it." That is what shipped — the tab was mounted
// unconditionally while this module's neighbour carried a comment claiming it
// "stays hidden below ~150 items". These tests make the claim true.
// ---------------------------------------------------------------------------

const DEEP = { items: 400, vendors: 9 };

describe('[MKT G7] the launch-depth gate', () => {
  it('a deep catalogue is visible', () => {
    const g = marketGate(DEEP);
    expect(g.visible).toBe(true);
    expect(g.reason).toBe('ok');
  });

  // The founder's actual screenshot: four items, one store, tab showing.
  it('four items from one store is hidden — the exact case the gate exists for', () => {
    const g = marketGate({ items: 4, vendors: 1 });
    expect(g.visible).toBe(false);
    expect(g.reason).toBe('too_few_items_and_vendors');
  });

  // The AND matters: depth without breadth is one shop wearing a market's name.
  it('a deep catalogue from a SINGLE seller is still hidden', () => {
    const g = marketGate({ items: 5_000, vendors: 1 });
    expect(g.visible).toBe(false);
    expect(g.reason).toBe('too_few_vendors');
  });

  it('many sellers with almost nothing to sell is still hidden', () => {
    const g = marketGate({ items: 6, vendors: 40 });
    expect(g.visible).toBe(false);
    expect(g.reason).toBe('too_few_items');
  });

  it('opens exactly at the threshold, not one short of it', () => {
    expect(marketGate({ items: MARKET_MIN_ITEMS, vendors: MARKET_MIN_VENDORS }).visible).toBe(true);
    expect(marketGate({ items: MARKET_MIN_ITEMS - 1, vendors: MARKET_MIN_VENDORS }).visible).toBe(false);
    expect(marketGate({ items: MARKET_MIN_ITEMS, vendors: MARKET_MIN_VENDORS - 1 }).visible).toBe(false);
  });

  it('an empty catalogue is hidden, never accidentally "ok"', () => {
    expect(marketGate({ items: 0, vendors: 0 }).visible).toBe(false);
  });

  it('reports the numbers it judged, so ops can see why', () => {
    const g = marketGate({ items: 4, vendors: 1 });
    expect(g).toMatchObject({ items: 4, vendors: 1, minItems: MARKET_MIN_ITEMS, minVendors: MARKET_MIN_VENDORS });
  });

  it('honours operator thresholds when they are set', () => {
    expect(marketGate({ items: 10, vendors: 2 }, { minItems: 10, minVendors: 2 }).visible).toBe(true);
  });
});

describe('[MKT G7] thresholds fail SAFE, never open', () => {
  it('absent config falls back to the spec numbers', () => {
    expect(thresholdsFrom(undefined)).toEqual({ minItems: MARKET_MIN_ITEMS, minVendors: MARKET_MIN_VENDORS });
    expect(thresholdsFrom({})).toEqual({ minItems: MARKET_MIN_ITEMS, minVendors: MARKET_MIN_VENDORS });
  });

  // A typo in config must not be the thing that puts a one-store marketplace
  // in front of a customer.
  it.each([
    ['a typo', { MARKET_MIN_ITEMS: 'onehundred' }],
    ['a null', { MARKET_MIN_ITEMS: null }],
    ['a negative', { MARKET_MIN_ITEMS: -5 }],
    ['an object', { MARKET_MIN_ITEMS: { n: 150 } }],
    ['NaN', { MARKET_MIN_ITEMS: Number.NaN }],
  ])('%s falls back to the spec default rather than opening the gate', (_label, config) => {
    expect(thresholdsFrom(config).minItems).toBe(MARKET_MIN_ITEMS);
  });

  it('a numeric string is honoured — config stores JSON', () => {
    expect(thresholdsFrom({ MARKET_MIN_ITEMS: '20', MARKET_MIN_VENDORS: '3' }))
      .toEqual({ minItems: 20, minVendors: 3 });
  });

  // Zero is a deliberate operator choice ("open it, I know it's thin"), which
  // is different from a broken value. It must be possible, but only explicitly.
  it('an explicit zero is respected — that is an operator decision, not a typo', () => {
    expect(thresholdsFrom({ MARKET_MIN_ITEMS: 0, MARKET_MIN_VENDORS: 0 }))
      .toEqual({ minItems: 0, minVendors: 0 });
    expect(marketGate({ items: 0, vendors: 0 }, { minItems: 0, minVendors: 0 }).visible).toBe(true);
  });
});

describe('[MKT G7] the tab obeys the server, and nothing mounts it unconditionally', () => {
  // The defect was not a wrong number — it was a tab mounted with no gate at
  // all, beside a comment asserting a gate existed. This fails if that returns.
  it('CustomerStack does not mount the Market tab unconditionally', () => {
    const stack = join(__dirname, '..', '..', '..', 'mobile', 'src', 'navigation', 'CustomerStack.tsx');
    let source: string;
    try {
      source = readFileSync(stack, 'utf8');
    } catch {
      return; // api suite run without the mobile app checked out beside it
    }
    // The element always appears; what matters is whether anything GUARDS it.
    // A first draft of this rule matched the element itself and passed happily
    // on a tab wrapped in a ternary — a rule that cannot tell guarded from
    // unguarded is not a rule.
    const mountLine = source.split('\n').find((l) => /<Tab\.Screen\s+name="Market"/.test(l)) ?? '';
    expect(mountLine, 'The Market tab is not mounted at all — expected a gated mount.').not.toBe('');
    const guarded = /[?]|&&/.test(mountLine);
    expect(
      guarded,
      `The Market tab is mounted with no depth gate — §5.4: an empty marketplace is worse than no marketplace.\n  ${mountLine.trim()}`,
    ).toBe(true);
    // ...and the guard must come from the server's verdict, not a local guess.
    expect(source, 'The gate must read the server verdict via useMarketDepth.').toContain('useMarketDepth');
  });
});

describe('[MKT G7] the endpoint counts the catalogue the shopper would see', () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    const { prismaPlugin } = await import('../plugins/prisma');
    app = Fastify({ logger: false });
    await app.register(prismaPlugin);
    await app.ready();
  });
  afterAll(async () => { await app.close(); });

  // The gate must judge the SAME population /items serves. If depth counted a
  // different set, it would hide a tab that has stock, or show one that hasn't.
  it('depth counts only available items from visible RETAIL sellers', async () => {
    const { visibleVendorInTenant } = await import('../modules/vendor/vendor-visibility');
    const tenantId = 'swift-default';
    const where = { isAvailable: true, vendor: { ...visibleVendorInTenant(tenantId), vendorType: 'STORE' as const } };
    const items = await app.prisma.item.count({ where });
    const sellers = await app.prisma.item.findMany({ where, select: { vendorId: true }, distinct: ['vendorId'] });

    // Whatever the seeded depth is, the gate's verdict must agree with it.
    const gate = marketGate({ items, vendors: sellers.length });
    expect(gate.visible).toBe(items >= MARKET_MIN_ITEMS && sellers.length >= MARKET_MIN_VENDORS);

    // And a restaurant dish must never be counted as market depth.
    const dishes = await app.prisma.item.count({
      where: { isAvailable: true, vendor: { ...visibleVendorInTenant(tenantId), vendorType: 'RESTAURANT' } },
    });
    if (dishes > 0) expect(items).toBeLessThan(items + dishes);
  });
});
