import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../kit/toast', () => ({
  toast: { error: vi.fn() },
}));

import { PUBLIC_MARKET_DEPTH_KEY } from './customerSurfaceState';
import { clearPrincipalQueryCache } from './queryClient';

describe('clearPrincipalQueryCache', () => {
  it('removes principal data and mutations but retains sanitized public depth', () => {
    const client = new QueryClient();
    const updatedAt = 1_725_000_000_000;
    client.setQueryData(
      PUBLIC_MARKET_DEPTH_KEY,
      { visible: true, items: 150, vendors: 2, tenantId: 'secret' },
      { updatedAt },
    );
    client.setQueryData(['customer', 'home', 7, null, null], { customerId: 'a' });
    client.setQueryData(['customer', 'orders'], [{ id: 'order-a' }]);
    client.getMutationCache().build(client, {
      mutationKey: ['customer', 'mutation'],
      mutationFn: async () => 'done',
    });

    clearPrincipalQueryCache(client);

    expect(client.getQueryData(['customer', 'home', 7, null, null])).toBeUndefined();
    expect(client.getQueryData(['customer', 'orders'])).toBeUndefined();
    expect(client.getMutationCache().getAll()).toHaveLength(0);
    expect(client.getQueryData(PUBLIC_MARKET_DEPTH_KEY)).toEqual({
      visible: true,
      items: 150,
      vendors: 2,
    });
    expect(client.getQueryState(PUBLIC_MARKET_DEPTH_KEY)?.dataUpdatedAt).toBe(updatedAt);
  });

  it('retains a confirmed hidden result and drops malformed depth', () => {
    const hidden = new QueryClient();
    hidden.setQueryData(PUBLIC_MARKET_DEPTH_KEY, { visible: false, items: 149, vendors: 2 });
    clearPrincipalQueryCache(hidden);
    expect(hidden.getQueryData(PUBLIC_MARKET_DEPTH_KEY)).toEqual({
      visible: false,
      items: 149,
      vendors: 2,
    });

    const malformed = new QueryClient();
    malformed.setQueryData(PUBLIC_MARKET_DEPTH_KEY, { visible: true, items: -1, vendors: 2 });
    clearPrincipalQueryCache(malformed);
    expect(malformed.getQueryData(PUBLIC_MARKET_DEPTH_KEY)).toBeUndefined();
  });
});
