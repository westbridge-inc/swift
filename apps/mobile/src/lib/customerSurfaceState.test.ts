import { describe, expect, it } from 'vitest';
import {
  classifyHomeSurface,
  classifyMarketDepth,
  customerHomeKey,
  decodePublicMarketDepth,
  homePlaceholderForCoordinateChange,
  retryTransientReadOnce,
} from './customerSurfaceState';

function axiosFailure(status?: number): unknown {
  return {
    isAxiosError: true,
    response: status === undefined ? undefined : { status },
  };
}

describe('customer Home cache boundary', () => {
  const previous = { activeOrder: { id: 'order-a' } };

  it('keeps the same principal Home only while location becomes known', () => {
    const next = customerHomeKey(7, 6.801, -58.155);
    expect(homePlaceholderForCoordinateChange(
      previous,
      customerHomeKey(7),
      next,
    )).toBe(previous);
  });

  it('never carries Home across principals, known locations or foreign keys', () => {
    const next = customerHomeKey(8, 6.801, -58.155);
    expect(homePlaceholderForCoordinateChange(previous, customerHomeKey(7), next)).toBeUndefined();
    expect(homePlaceholderForCoordinateChange(
      previous,
      customerHomeKey(8, 6.8, -58.15),
      next,
    )).toBeUndefined();
    expect(homePlaceholderForCoordinateChange(previous, ['orders'], next)).toBeUndefined();
  });

  it.each([
    ['initial-loading', false, 'pending', 'fetching', true, false],
    ['initial-paused', false, 'pending', 'paused', false, false],
    ['initial-error', false, 'error', 'idle', false, false],
    ['stale-error', true, 'error', 'idle', false, false],
    ['stale-paused', true, 'success', 'paused', false, false],
    ['stale-location', true, 'success', 'idle', false, true],
    ['refreshing', true, 'success', 'fetching', true, false],
    ['ready', true, 'success', 'idle', false, false],
  ] as const)(
    'classifies %s without hiding saved data',
    (expected, hasData, status, fetchStatus, isFetching, isPlaceholderData) => {
      expect(classifyHomeSurface({
        hasData,
        status,
        fetchStatus,
        isFetching,
        isPlaceholderData,
      })).toBe(expected);
    },
  );
});

describe('bounded customer reads', () => {
  it.each([undefined, 408, 429, 500, 503])('retries one transient failure (%s)', (status) => {
    expect(retryTransientReadOnce(0, axiosFailure(status))).toBe(true);
    expect(retryTransientReadOnce(1, axiosFailure(status))).toBe(false);
  });

  it('does not retry ordinary client or programming errors', () => {
    expect(retryTransientReadOnce(0, axiosFailure(400))).toBe(false);
    expect(retryTransientReadOnce(0, new Error('programming error'))).toBe(false);
  });
});

describe('public Market depth boundary', () => {
  it('keeps only valid public aggregates', () => {
    expect(decodePublicMarketDepth({
      visible: true,
      items: 150,
      vendors: 2,
      privateTenant: 'must-not-survive',
    })).toEqual({ visible: true, items: 150, vendors: 2 });
  });

  it.each([
    null,
    [],
    { visible: 'yes', items: 150, vendors: 2 },
    { visible: true, items: -1, vendors: 2 },
    { visible: true, items: 1.5, vendors: 2 },
    { visible: true, items: 150, vendors: Number.NaN },
  ])('rejects malformed depth %#', (value) => {
    expect(decodePublicMarketDepth(value)).toBeNull();
  });

  it('keeps unknown, unavailable, hidden and visible distinct', () => {
    expect(classifyMarketDepth(undefined, false)).toBe('unknown');
    expect(classifyMarketDepth(undefined, true)).toBe('unavailable');
    expect(classifyMarketDepth({ visible: false, items: 149, vendors: 2 }, false)).toBe('hidden');
    expect(classifyMarketDepth({ visible: true, items: 150, vendors: 2 }, false)).toBe('visible');
    expect(classifyMarketDepth({ visible: true, items: 150, vendors: 2 }, true)).toBe('visible');
  });
});
