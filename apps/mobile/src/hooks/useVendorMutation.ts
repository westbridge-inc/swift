import { useMutation, type UseMutationOptions } from '@tanstack/react-query';
import { useStoreSwitcher } from '../stores/storeSwitcher';

/** Capture at render, and check immediately before EACH send (including step-up
 * retries). An editor/callback retired by a store switch cannot borrow B's header. */
export function guardVendorOperation<A extends unknown[], R>(fn: (...args: A) => Promise<R>): (...args: A) => Promise<R> {
  const { selectedStoreId, storeGeneration } = useStoreSwitcher.getState();
  return async (...args) => {
    const current = useStoreSwitcher.getState();
    if (current.selectedStoreId !== selectedStoreId || current.storeGeneration !== storeGeneration) {
      throw new Error('The store changed. Open the current store and try again.');
    }
    return fn(...args);
  };
}

export function useVendorMutation<TData = unknown, TError = unknown, TVars = void, TCtx = unknown>(
  options: UseMutationOptions<TData, TError, TVars, TCtx>,
) {
  return useMutation({
    ...options,
    mutationFn: options.mutationFn ? guardVendorOperation(options.mutationFn) : undefined,
  });
}
