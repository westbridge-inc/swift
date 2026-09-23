import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  invalidateQueries: vi.fn(),
}));

vi.mock('@tanstack/react-query', () => ({
  useQuery: (options: unknown) => options,
  useMutation: (options: unknown) => options,
  useQueryClient: () => ({ invalidateQueries: mocks.invalidateQueries }),
}));
vi.mock('../stores/authStore', () => ({
  useAuthStore: (selector: (state: { user: { id: string } }) => unknown) => selector({ user: { id: 'provider-1' } }),
  requireAuthSessionSnapshot: vi.fn(),
  requireAuthSessionForPrincipal: vi.fn(),
}));
vi.mock('../services/api', () => ({ servicesApi: {} }));
vi.mock('../lib/analytics', () => ({ track: vi.fn() }));

import { useSaveServiceProvider, useServiceProviderProfile } from './services';

beforeEach(() => mocks.invalidateQueries.mockClear());

describe('service provider profile query', () => {
  it('stops the actual profile query interval on a held category', () => {
    const query = useServiceProviderProfile() as unknown as {
      queryKey: unknown[];
      refetchInterval: (query: { state: { data: unknown } }) => number | false;
    };
    expect(query.queryKey).toEqual(['services', 'provider-me', 'provider-1']);
    expect(query.refetchInterval({ state: { data: { isVerified: false, categoryUnavailable: true } } })).toBe(false);
    expect(query.refetchInterval({ state: { data: { isVerified: false, categoryUnavailable: false } } })).toBe(15_000);
  });

  it('invalidates profile and verification status after a successful edit', () => {
    const mutation = useSaveServiceProvider() as unknown as { onSuccess: () => void };
    mutation.onSuccess();
    expect(mocks.invalidateQueries).toHaveBeenCalledWith({ queryKey: ['services', 'provider-me'] });
    expect(mocks.invalidateQueries).toHaveBeenCalledWith({ queryKey: ['verification', 'SERVICE_PROVIDER'] });
  });
});
