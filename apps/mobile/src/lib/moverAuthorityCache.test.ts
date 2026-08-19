import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import {
  canonicalMoverAuthority,
  clearMoverAuthorityCache,
} from './moverAuthorityCache';

describe('canonicalMoverAuthority', () => {
  it('uses the server-selected subtype instead of the generic requested role', () => {
    expect(canonicalMoverAuthority(
      { activeRole: 'RIDER', lastMoverRole: 'RIDER' },
      'MOVER',
      'DRIVER',
    )).toEqual({ activeRole: 'RIDER', lastMoverRole: 'RIDER' });
  });

  it('preserves remembered mover work while visiting customer or business', () => {
    expect(canonicalMoverAuthority({ activeRole: 'CUSTOMER' }, 'CUSTOMER', 'RIDER'))
      .toEqual({ activeRole: 'CUSTOMER', lastMoverRole: 'RIDER' });
    expect(canonicalMoverAuthority({ activeRole: 'VENDOR_OWNER', lastMoverRole: null }, 'VENDOR', 'DRIVER'))
      .toEqual({ activeRole: 'VENDOR_OWNER', lastMoverRole: null });
  });

  it('derives safe subtype memory from a specific old-server response', () => {
    expect(canonicalMoverAuthority({}, 'DRIVER', null))
      .toEqual({ activeRole: 'DRIVER', lastMoverRole: 'DRIVER' });
  });
});

describe('clearMoverAuthorityCache', () => {
  it('removes the whole mover authority family and preserves other surfaces', () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(['mover', 'driverProfile'], { isOnline: true });
    queryClient.setQueryData(['mover', 'active', 'DRIVER'], { id: 'ride-1' });
    queryClient.setQueryData(['customer', 'profile'], { id: 'customer-1' });

    clearMoverAuthorityCache(queryClient);

    expect(queryClient.getQueryData(['mover', 'driverProfile'])).toBeUndefined();
    expect(queryClient.getQueryData(['mover', 'active', 'DRIVER'])).toBeUndefined();
    expect(queryClient.getQueryData(['customer', 'profile'])).toEqual({ id: 'customer-1' });
  });
});
