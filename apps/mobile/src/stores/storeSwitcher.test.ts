import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MutationObserver } from '@tanstack/react-query';

vi.mock('../kit/toast', () => ({ toast: { error: vi.fn() } }));
vi.mock('../services/socket', () => ({ disconnectSocket: vi.fn() }));
import { queryClient } from '../lib/queryClient';
import { disconnectSocket } from '../services/socket';
import { useStoreSwitcher } from './storeSwitcher';
import { guardVendorOperation } from '../hooks/useVendorMutation';

beforeEach(() => {
  queryClient.clear();
  useStoreSwitcher.setState({ selectedStoreId: 'store-a', storeGeneration: 0 });
  vi.clearAllMocks();
});

describe('the single store handoff', () => {
  it('removes vendor/verification facts before publishing B and discards A’s late read', async () => {
    queryClient.setQueryData(['vendor', 'hours'], ['A hours']);
    queryClient.setQueryData(['verification', 'RESTAURANT'], ['A documents']);
    queryClient.setQueryData(['customer', 'favorites'], ['keep']);
    let finish!: (value: string[]) => void;
    const oldRead = queryClient.fetchQuery({
      queryKey: ['vendor', 'menu'],
      queryFn: () => new Promise<string[]>((resolve) => { finish = resolve; }),
    }).catch(() => undefined);
    let observed = false;
    const unsubscribe = useStoreSwitcher.subscribe((state) => {
      if (state.selectedStoreId !== 'store-b') return;
      observed = true;
      expect(queryClient.getQueryData(['vendor', 'hours'])).toBeUndefined();
      expect(queryClient.getQueryData(['verification', 'RESTAURANT'])).toBeUndefined();
    });
    try {
      useStoreSwitcher.getState().setSelectedStore('store-b');
      finish(['late A menu']);
      await oldRead;
      expect(observed).toBe(true);
      expect(queryClient.getQueryData(['vendor', 'menu'])).toBeUndefined();
      expect(queryClient.getQueryData(['customer', 'favorites'])).toEqual(['keep']);
      expect(disconnectSocket).toHaveBeenCalledOnce();
    } finally { unsubscribe(); }
  });

  it('rejects an hours mutation queued under A before its network function starts under B', async () => {
    const send = vi.fn(async () => ({ store: useStoreSwitcher.getState().selectedStoreId }));
    let resume!: () => void;
    const started = new Promise<void>((resolve) => { resume = resolve; });
    const mutation = new MutationObserver(queryClient, {
      mutationFn: guardVendorOperation(send),
      onMutate: () => started,
    });
    const pending = mutation.mutate();
    useStoreSwitcher.getState().setSelectedStore('store-b');
    resume();
    await expect(pending).rejects.toThrow('store changed');
    expect(send).not.toHaveBeenCalled();
  });
});
