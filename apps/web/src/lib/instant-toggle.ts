import type { QueryClient, QueryKey } from '@tanstack/react-query';

// [PERF row 562] A tap answers on screen at once. A SAFE, REVERSIBLE switch
// (store open, accepting orders, an item in stock) used to wait for the
// server's answer AND a fresh read before it moved: two round trips abroad,
// about a third of a second on a good line and over a second on a slow one,
// with the switch only dimmed meanwhile. Now it moves in the same frame
// (dimmed until the server confirms), goes back if the server refuses (the
// page's notice says why), and the page is re-read afterwards either way.
//
// Money and dispatch never use this: paying, refunds, accepting or handing
// over an order, delivery mode. Those show progress at once but show success
// only after the server confirms.

export function instantSwitch<V, D, R = unknown>(
  queryClient: QueryClient,
  key: QueryKey,
  apply: (_data: D, _value: V, _undo: boolean) => D,
  settle: () => unknown,
  /** The server's own answer, shown as soon as it arrives (before the re-read). */
  confirm?: (_data: D, _response: R) => D,
) {
  return {
    onMutate: async (value: V) => {
      // A read already on its way would land with the old state on top of the new one.
      await queryClient.cancelQueries({ queryKey: key });
      queryClient.setQueryData<D>(key, (data) => (data === undefined ? data : apply(data, value, false)));
    },
    onSuccess: (response: R) => {
      if (confirm) queryClient.setQueryData<D>(key, (data) => (data === undefined ? data : confirm(data, response)));
    },
    onError: (_error: unknown, value: V) => {
      queryClient.setQueryData<D>(key, (data) => (data === undefined ? data : apply(data, value, true)));
    },
    // The re-read runs on its own: the switch is confirmed by the server's answer, not by the re-read.
    onSettled: () => { void settle(); },
  };
}
