import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { MMG_DISPUTE_NOTICE, mmgDisputePaused, withoutForwardWorkWhilePaused } from './order-dispute';

// [NO-DEAD-ENDS · S1-6] A disputed direct-MMG order is paused until Swift
// resolves it. The store's board and order screen showed it like any other
// order, with a forward button the server refused on every tap.

const disputed = { paymentMethod: 'MOBILE_MONEY', orderType: 'FOOD_DELIVERY', status: 'PENDING', mmgClaimMismatchAt: '2026-10-06T20:00:00.000Z' };
const actions = (...kinds: string[]) => kinds.map((action) => ({ label: action, action }));

describe('mmgDisputePaused', () => {
  it('is true only for an open, non-taxi MMG order the server marked disputed', () => {
    expect(mmgDisputePaused(disputed)).toBe(true);
    expect(mmgDisputePaused({ ...disputed, status: 'PREPARING' })).toBe(true);
    expect(mmgDisputePaused({ ...disputed, mmgClaimMismatchAt: null })).toBe(false);
    expect(mmgDisputePaused({ ...disputed, mmgClaimMismatchAt: undefined })).toBe(false);
    expect(mmgDisputePaused({ ...disputed, paymentMethod: 'CASH' })).toBe(false);
    expect(mmgDisputePaused({ ...disputed, orderType: 'TAXI' })).toBe(false);
    expect(mmgDisputePaused({ ...disputed, status: 'CANCELLED' })).toBe(false);
    expect(mmgDisputePaused(null)).toBe(false);
  });
});

describe('withoutForwardWorkWhilePaused', () => {
  it('withholds every forward step while paused and keeps only a decline the board already offered', () => {
    expect(withoutForwardWorkWhilePaused(disputed, actions('accept', 'reject')).map((a) => a.action)).toEqual(['reject']);
    expect(withoutForwardWorkWhilePaused({ ...disputed, status: 'ACCEPTED' }, actions('preparing'))).toEqual([]);
    expect(withoutForwardWorkWhilePaused({ ...disputed, status: 'PREPARING' }, actions('ready'))).toEqual([]);
  });
  it('control: an undisputed order keeps every action it had', () => {
    const undisputed = { ...disputed, mmgClaimMismatchAt: null };
    expect(withoutForwardWorkWhilePaused(undisputed, actions('accept', 'reject')).map((a) => a.action)).toEqual(['accept', 'reject']);
  });
});

describe('the store sees the paused state where it works the order', () => {
  const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
  it('every vendor action list goes through the pause, and the board card and order screen say why', () => {
    const shared = read('./shared.tsx');
    const start = shared.indexOf('export function orderActions(');
    const body = shared.slice(start, shared.indexOf('\nfunction statusActions(', start));
    expect(start).toBeGreaterThan(-1);
    expect(body).toContain('return withoutForwardWorkWhilePaused(order, statusActions(order));');
    expect(shared).toContain('testID="vendor-mmg-dispute-notice"');
    expect(read('./screens/VendorOps.tsx')).toContain('<MmgDisputeNotice order={order} />');
    expect(read('./screens/VendorOrderDetailScreen.tsx')).toContain('<MmgDisputeNotice order={order} />');
    expect(MMG_DISPUTE_NOTICE.title).toBe('Payment under review — order paused');
    expect(MMG_DISPUTE_NOTICE.body).toMatch(/will tell you when the order can move/);
  });
});
