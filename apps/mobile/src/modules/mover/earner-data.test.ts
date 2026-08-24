import { describe, expect, it } from 'vitest';
import {
  earningRows,
  earningsWindowTotal,
  hasEarningRowsPayload,
  historyEarningAmount,
  historyItemSummary,
  historyTip,
  mergeUniqueRows,
  moneyOrDash,
  recentEarningsBreakdown,
  serverCount,
  serverNumber,
} from './earner-data';

describe('earner server-value guards', () => {
  it('preserves a real zero but never turns absence or junk into one', () => {
    expect(serverNumber(0)).toBe(0);
    expect(serverNumber('1200')).toBe(1200);
    for (const absent of [undefined, null, '', 'not-a-number', NaN, Infinity]) {
      expect(serverNumber(absent)).toBeUndefined();
    }
    expect(serverCount(3)).toBe(3);
    expect(serverCount(3.5)).toBeUndefined();
    expect(moneyOrDash(0)).toBe('$0');
    expect(moneyOrDash(undefined)).toBe('—');
  });

  it('reads both the live summary contract and the legacy read-only preview without inventing windows', () => {
    expect(earningsWindowTotal({ thisWeek: { total: 48_600, count: 31 } }, 'thisWeek', 'week')).toBe(48_600);
    expect(earningsWindowTotal({ week: 56_700 }, 'thisWeek', 'week')).toBe(56_700);
    expect(earningsWindowTotal({ week: 56_700 }, 'allTime')).toBeUndefined();
  });
});

describe('recent earnings truth', () => {
  it('splits only a complete, supported recent page', () => {
    const rows = earningRows({
      data: [
        { id: 'fee', type: 'DELIVERY_FEE', amount: 1100 },
        { id: 'tip', type: 'TIP', amount: 300 },
      ],
    });
    expect(recentEarningsBreakdown(rows)).toEqual({ fees: 1100, tips: 300 });
    expect(recentEarningsBreakdown([{ type: 'DELIVERY_FEE', amount: 1100 }]))
      .toEqual({ fees: 1100 });
    expect(recentEarningsBreakdown([{ type: 'TIP', amount: 0 }]))
      .toEqual({ tips: 0 });
    expect(recentEarningsBreakdown([{ type: 'TIP' }])).toBeUndefined();
    expect(recentEarningsBreakdown([])).toBeUndefined();
    expect(hasEarningRowsPayload([])).toBe(true);
    expect(hasEarningRowsPayload({ data: [] })).toBe(true);
    expect(hasEarningRowsPayload({})).toBe(false);
    expect(hasEarningRowsPayload({ data: [null] })).toBe(false);
  });
});

describe('job-history earnings truth', () => {
  it('uses the rider totalEarning field and never the customer order total', () => {
    expect(historyEarningAmount({ status: 'DELIVERED', totalEarning: 1300, totalAmount: 9200 }, false)).toBe(1300);
    expect(historyEarningAmount({ status: 'DELIVERED', totalAmount: 9200 }, false)).toBeUndefined();
  });

  it('adds a completed taxi tip but never invents cancelled earnings', () => {
    expect(historyEarningAmount({ status: 'DELIVERED', taxiFareTotal: 1500, tipAmount: 300 }, true)).toBe(1800);
    expect(historyTip({ status: 'DELIVERED', tipAmount: 300 })).toBe(300);
    expect(historyEarningAmount({ status: 'CANCELLED', taxiFareTotal: 1500 }, true)).toBeUndefined();
    expect(historyTip({ status: 'CANCELLED', tipAmount: 300 })).toBeUndefined();
  });

  it('prints only item fields the server actually supplied', () => {
    expect(historyItemSummary([{ quantity: 1, name: 'Chicken curry' }, { name: 'Mauby' }]))
      .toBe('1× Chicken curry · Mauby');
    expect(historyItemSummary([{ quantity: 2 }])).toBeUndefined();
  });

  it('deduplicates a refetched page by its server ids', () => {
    expect(mergeUniqueRows(
      [{ id: 'a', status: 'DELIVERED' }, { id: 'b', status: 'DELIVERED' }],
      [{ id: 'b', status: 'CANCELLED' }, { id: 'c', status: 'DELIVERED' }],
    )).toEqual([
      { id: 'a', status: 'DELIVERED' },
      { id: 'b', status: 'CANCELLED' },
      { id: 'c', status: 'DELIVERED' },
    ]);
    expect(mergeUniqueRows([{ id: 'a' }], [{ status: 'DELIVERED' }]))
      .toEqual([{ id: 'a' }]);
  });
});
