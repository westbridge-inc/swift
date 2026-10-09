import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ConfirmationRequestLocks, useConfirmationRequestLocks } from './confirmation-request-locks';

describe('confirmation request locks', () => {
  it('a reload never clears an unanswered request, and clears only uncertain answers recorded before it started', () => {
    const locks = new ConfirmationRequestLocks();
    locks.sending('in-flight');
    locks.reloadRequired('before');
    const mark = locks.mark();
    locks.reloadRequired('after'); // answered while the reload was reading
    locks.reloaded(mark);
    expect(Object.keys(locks.current()).sort()).toEqual(['after', 'in-flight']);
    expect(locks.current()['in-flight']?.state).toBe('sending');
    locks.release('in-flight');
    locks.reloaded(locks.mark());
    expect(locks.current()).toEqual({});
  });

  it('the locks outlive the page: the same console client keeps them, another client starts empty', () => {
    const consoleClient = new QueryClient();
    const wrap = (client: QueryClient) => function Console({ children }: { children: ReactNode }) {
      return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
    };
    const first = renderHook(() => useConfirmationRequestLocks(), { wrapper: wrap(consoleClient) });
    act(() => first.result.current.store.reloadRequired('hold-one'));
    expect(first.result.current.locks['hold-one']?.state).toBe('reload');
    first.unmount();
    const again = renderHook(() => useConfirmationRequestLocks(), { wrapper: wrap(consoleClient) });
    expect(again.result.current.locks['hold-one']?.state).toBe('reload');
    const other = renderHook(() => useConfirmationRequestLocks(), { wrapper: wrap(new QueryClient()) });
    expect(other.result.current.locks).toEqual({});
  });
});
