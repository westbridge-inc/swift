import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BUCKETS, STATUS_BUCKET, bucketFor, completeness, groupOrders } from './order-buckets';

// ---------------------------------------------------------------------------
// [W-11] S0 operational truth. The vendor order board grouped orders with
// `BUCKETS.find(...)` and pushed only on a hit — no else — so an order whose
// status matched no lane was silently dropped: not shown, not counted, not
// mentioned. The lanes were also not exhaustive, and four of their matchers
// named statuses that do not exist.
// ---------------------------------------------------------------------------

/** The statuses the API can actually send, read from the shared enum. */
function enumStatuses(): string[] {
  const src = readFileSync(
    join(process.cwd(), '../../packages/types/src/order.ts'),
    'utf8',
  );
  const body = /export enum OrderStatus \{([\s\S]*?)\}/.exec(src);
  if (!body) throw new Error('OrderStatus enum not found in packages/types');
  return [...body[1]!.matchAll(/^\s*([A-Z_]+)\s*=/gm)].map((m) => m[1]!);
}

describe('[W-11] every status the server can send has a lane', () => {
  it('census: STATUS_BUCKET is 1:1 with the OrderStatus enum', () => {
    // A status added to the enum turns this red instead of quietly making those
    // orders invisible on the board.
    expect(Object.keys(STATUS_BUCKET).sort()).toEqual(enumStatuses().sort());
  });

  it('the four states that were invisible are now in a visible lane', () => {
    // measured against the old matchers: these matched nothing and were dropped
    expect(bucketFor('EN_ROUTE_DELIVERY')).toBe('moving');
    expect(bucketFor('ARRIVED')).toBe('moving');
    expect(bucketFor('REFUNDED')).toBe('attention');
    expect(bucketFor('FAILED')).toBe('attention');
    for (const s of ['EN_ROUTE_DELIVERY', 'ARRIVED', 'REFUNDED', 'FAILED']) {
      expect(bucketFor(s)).not.toBe('unknown');
    }
  });

  it('every lane named in STATUS_BUCKET is a lane the board renders', () => {
    const rendered = new Set(BUCKETS.map((b) => b.key));
    for (const [status, key] of Object.entries(STATUS_BUCKET)) {
      expect(rendered.has(key), `${status} → ${key}`).toBe(true);
    }
  });

  it('an unrecognised status is loud, never dropped', () => {
    expect(bucketFor('SOME_FUTURE_STATE')).toBe('unknown');
    expect(bucketFor('')).toBe('unknown');
    expect(bucketFor(null)).toBe('unknown');
    expect(bucketFor(undefined)).toBe('unknown');
    expect(BUCKETS.some((b) => b.key === 'unknown')).toBe(true);
  });

  it('matches case-insensitively, as the board does', () => {
    expect(bucketFor('pending')).toBe('new');
  });
});

describe('[W-11] grouping conserves orders', () => {
  const order = (status: string, id: string) => ({ id, status });

  it('the count out equals the count in — the property the old loop broke', () => {
    const orders = [
      order('PENDING', '1'), order('EN_ROUTE_DELIVERY', '2'), order('ARRIVED', '3'),
      order('REFUNDED', '4'), order('FAILED', '5'), order('SOMETHING_NEW', '6'),
      order('DELIVERED', '7'),
    ];
    const grouped = groupOrders(orders);
    const out = [...grouped.values()].reduce((n, rows) => n + rows.length, 0);
    expect(out).toBe(orders.length);
    // and specifically: none of these vanished
    const ids = [...grouped.values()].flat().map((o) => o.id).sort();
    expect(ids).toEqual(['1', '2', '3', '4', '5', '6', '7']);
  });

  it('the old behaviour, pinned: a find/if-match loop loses exactly these', () => {
    // this is what the board did, reproduced so the regression is visible
    const legacy = [
      { key: 'new', match: (s: string) => s === 'PENDING' || s === 'PLACED' },
      { key: 'moving', match: (s: string) => ['PICKED_UP', 'RIDER_EN_ROUTE_DROPOFF'].includes(s) },
      { key: 'done', match: (s: string) => ['DELIVERED', 'COMPLETED', 'CANCELLED'].includes(s) },
    ];
    const orders = [order('EN_ROUTE_DELIVERY', '2'), order('ARRIVED', '3'), order('REFUNDED', '4')];
    const kept = orders.filter((o) => legacy.some((b) => b.match(o.status)));
    expect(kept).toHaveLength(0); // all three were invisible
    expect([...groupOrders(orders).values()].flat()).toHaveLength(3); // now none are
  });

  it('every lane exists in the result even when empty', () => {
    const grouped = groupOrders([]);
    for (const b of BUCKETS) expect(grouped.has(b.key), b.key).toBe(true);
  });
});

describe('[W-11] the board may not overstate what it is showing', () => {
  it('knows when orders exist that it is not showing', () => {
    expect(completeness(100, { total: 143 })).toMatchObject({ total: 143, shown: 100, missing: 43, complete: false });
  });

  it('is complete only when the server said so', () => {
    expect(completeness(12, { total: 12 })).toMatchObject({ missing: 0, complete: true });
  });

  it('an UNKNOWN total is not a complete one', () => {
    expect(completeness(100, undefined)).toMatchObject({ total: null, complete: false });
    expect(completeness(100, {})).toMatchObject({ total: null, complete: false });
    expect(completeness(100, { total: 'lots' })).toMatchObject({ total: null, complete: false });
  });

  it('never reports a negative shortfall', () => {
    expect(completeness(10, { total: 3 }).missing).toBe(0);
  });
});

describe('[W-11] the board uses it', () => {
  const code = readFileSync(join(process.cwd(), 'src/app/dashboard/orders/page.tsx'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n');

  it('groups with the exhaustive grouper, not a find/if-match loop', () => {
    expect(code).toMatch(/groupOrders\(all\)/);
    expect(code).not.toMatch(/BUCKETS\.find\(\(x\) => x\.match/);
    expect(code).not.toMatch(/if \(b\) map\.get/);
  });

  it('an outage is not an empty queue', () => {
    expect(code).toMatch(/\{orders\.isError && \(/);
    // the calm empty state is reachable only when the read SUCCEEDED
    expect(code).toMatch(/!orders\.isLoading && !orders\.isError && list\.length === 0/);
  });

  it('says when it is not showing everything', () => {
    expect(code).toMatch(/shown\.missing > 0/);
    expect(code).toMatch(/completeness\(all\.length, orders\.data\?\.meta\)/);
  });
});
