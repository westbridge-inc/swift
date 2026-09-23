import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getItemSlots: vi.fn(),
  queryOptions: null as Record<string, any> | null,
}));

vi.mock('@tanstack/react-query', () => ({
  keepPreviousData: Symbol('keepPreviousData'),
  useInfiniteQuery: vi.fn(),
  useMutation: vi.fn(),
  useQueryClient: vi.fn(),
  useQuery: (options: Record<string, any>) => {
    mocks.queryOptions = options;
    return options;
  },
}));

vi.mock('../services/api', () => ({
  customerApi: { getItemSlots: mocks.getItemSlots },
  discoveryApi: {},
  marketApi: {},
  moderationApi: {},
}));
vi.mock('../lib/analytics', () => ({ track: vi.fn() }));
vi.mock('../lib/checkoutAttemptStore', () => ({ checkoutAttempt: {} }));
vi.mock('../lib/checkoutAttempt', () => ({ recordCheckoutOutcome: vi.fn(), stableBodyHash: vi.fn() }));
vi.mock('../stores/authStore', () => ({ getAuthSessionSnapshot: vi.fn() }));

import { useItemSlots } from './customer';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.queryOptions = null;
  mocks.getItemSlots.mockResolvedValue({ data: { data: { slots: [] } } });
});

describe('appointment-slot query transport', () => {
  it('fails within one bounded request instead of extending the blocking loader through automatic retries', () => {
    useItemSlots('service-item-1', '2026-09-24');

    expect(mocks.queryOptions).toMatchObject({
      queryKey: ['customer', 'slots', 'service-item-1', '2026-09-24'],
      enabled: true,
      retry: false,
      refetchInterval: 20_000,
    });
  });

  it('binds the request to React Query cancellation and an eight-second ceiling', async () => {
    useItemSlots('service-item-1', '2026-09-24');
    const signal = new AbortController().signal;

    await mocks.queryOptions!['queryFn']({ signal });

    expect(mocks.getItemSlots).toHaveBeenCalledExactlyOnceWith(
      'service-item-1',
      '2026-09-24',
      expect.objectContaining({ signal, timeout: 8_000 }),
    );
  });

  it('keeps each date in a separate cache key so a superseded day cannot populate the selected day', () => {
    useItemSlots('service-item-1', '2026-09-24');
    const first = mocks.queryOptions!['queryKey'];
    useItemSlots('service-item-1', '2026-09-25');
    const second = mocks.queryOptions!['queryKey'];

    expect(first).toEqual(['customer', 'slots', 'service-item-1', '2026-09-24']);
    expect(second).toEqual(['customer', 'slots', 'service-item-1', '2026-09-25']);
    expect(second).not.toEqual(first);
  });
});
