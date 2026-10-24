import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MutationObserver } from '@tanstack/react-query';

vi.mock('../kit/toast', () => ({ toast: { error: vi.fn() } }));
vi.mock('../services/socket', () => ({ disconnectSocket: vi.fn(), reconnectSocketForStoreHandoff: vi.fn() }));
import { queryClient } from '../lib/queryClient';
import { disconnectSocket, reconnectSocketForStoreHandoff } from '../services/socket';
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
      // A's store room is left only once B is published (AX449 #4).
      expect(reconnectSocketForStoreHandoff).not.toHaveBeenCalled();
    });
    try {
      useStoreSwitcher.getState().setSelectedStore('store-b');
      finish(['late A menu']);
      await oldRead;
      expect(observed).toBe(true);
      expect(queryClient.getQueryData(['vendor', 'menu'])).toBeUndefined();
      expect(queryClient.getQueryData(['customer', 'favorites'])).toEqual(['keep']);
      // Same account: the shared socket reconnects in place, never discarded.
      expect(reconnectSocketForStoreHandoff).toHaveBeenCalledOnce();
      expect(disconnectSocket).not.toHaveBeenCalled();
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

describe('R3 fee notification context and the shared socket at a handoff', () => {
  const recovery = { retry: async () => undefined, cancel: () => undefined };
  beforeEach(() => useStoreSwitcher.setState({ selectedStoreId: null, storeGeneration: 0, initialSelectionGeneration: null, feeContextPending: true, feeContextError: recovery }));

  it('the automatic first store keeps a cold notice; an explicit choice retires it', () => {
    useStoreSwitcher.getState().initializeSelectedStore('store-a');
    expect(useStoreSwitcher.getState()).toMatchObject({ selectedStoreId: 'store-a', feeContextPending: true, feeContextError: recovery });
    useStoreSwitcher.getState().setSelectedStore('store-b');
    expect(useStoreSwitcher.getState()).toMatchObject({ selectedStoreId: 'store-b', feeContextPending: false, feeContextError: null });
  });

  it('re-selecting the current store changes nothing', () => {
    useStoreSwitcher.setState({ selectedStoreId: 'store-a', storeGeneration: 4 });
    useStoreSwitcher.getState().setSelectedStore('store-a');
    expect(useStoreSwitcher.getState()).toMatchObject({ storeGeneration: 4, feeContextPending: true, feeContextError: recovery });
    expect(reconnectSocketForStoreHandoff).not.toHaveBeenCalled(); expect(disconnectSocket).not.toHaveBeenCalled();
  });

  it('clearing the selection is an account boundary: it retires fee context even when none was selected', () => {
    useStoreSwitcher.getState().setSelectedStore(null);
    expect(useStoreSwitcher.getState()).toMatchObject({ selectedStoreId: null, storeGeneration: 0, feeContextPending: false, feeContextError: null });
    expect(reconnectSocketForStoreHandoff).not.toHaveBeenCalled(); expect(disconnectSocket).not.toHaveBeenCalled();
  });

  it('clearing a selected store discards the socket; a first store from none touches no socket', () => {
    useStoreSwitcher.getState().setSelectedStore('store-a');
    expect(reconnectSocketForStoreHandoff).not.toHaveBeenCalled(); expect(disconnectSocket).not.toHaveBeenCalled();
    useStoreSwitcher.getState().setSelectedStore(null);
    expect(disconnectSocket).toHaveBeenCalledOnce(); expect(reconnectSocketForStoreHandoff).not.toHaveBeenCalled();
    expect(useStoreSwitcher.getState()).toMatchObject({ selectedStoreId: null, feeContextPending: false, feeContextError: null });
  });
});
