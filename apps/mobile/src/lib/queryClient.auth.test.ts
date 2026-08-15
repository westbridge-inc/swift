import { beforeEach, describe, expect, it, vi } from 'vitest';

const { toastError } = vi.hoisted(() => ({ toastError: vi.fn() }));

vi.mock('../components/ui/toast', () => ({
  toast: { error: toastError },
}));

import { queryClient } from './queryClient';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  queryClient.clear();
  toastError.mockClear();
});

describe('mutation retry boundary', () => {
  it('never re-invokes a state-changing mutation after the active account changes', async () => {
    vi.useFakeTimers();
    try {
      const firstAttempt = deferred<string>();
      const calls: string[] = [];
      let activeAccount = 'account-a';
      const failure = new Error('temporary network failure');

      const mutation = queryClient.getMutationCache().build<string, Error, void, unknown>(queryClient, {
        mutationKey: ['security-regression', 'state-changing-request'],
        mutationFn: () => {
          calls.push(activeAccount);
          return calls.length === 1
            ? firstAttempt.promise
            : Promise.resolve(`executed-as-${activeAccount}`);
        },
      });

      const result = mutation.execute().catch((error: unknown) => error);
      await vi.waitFor(() => expect(calls).toEqual(['account-a']));

      activeAccount = 'account-b';
      firstAttempt.reject(failure);
      await vi.advanceTimersByTimeAsync(1_000);

      await expect(result).resolves.toBe(failure);
      expect(calls).toEqual(['account-a']);
    } finally {
      vi.useRealTimers();
    }
  });
});
