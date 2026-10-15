'use client';

import { useSyncExternalStore } from 'react';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';

/**
 * Per-row locks for weekly-fee confirmation requests that must outlive the page.
 *
 * Page state dies when the admin follows "Open Approvals" or any sidebar link.
 * If the lock died with it, coming back would offer both decisions again while
 * an earlier request is still being sent, or after a reply that did not say
 * whether an approval was queued, and a second approval could be filed. The
 * locks are kept beside the console's one query client, so they last for the
 * whole console session and never leak between test clients.
 *
 * - `sending`: the request has not been answered. Nothing clears it but the answer.
 * - `reload`: the answer was uncertain. Only a complete reload of both lists,
 *   started after the answer, clears it.
 */
export type RequestLock = { state: 'sending' | 'reload'; seq: number };
export type RequestLocks = Readonly<Record<string, RequestLock>>;

export class ConfirmationRequestLocks {
  private locks: RequestLocks = {};
  private seq = 0;
  private readonly listeners = new Set<() => void>();

  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  readonly current = () => this.locks;
  /** Marks the point a reload starts from: only locks set before it can be cleared by it. */
  readonly mark = () => this.seq;

  sending(rowId: string) { this.set({ ...this.locks, [rowId]: { state: 'sending', seq: ++this.seq } }); }
  reloadRequired(rowId: string) { this.set({ ...this.locks, [rowId]: { state: 'reload', seq: ++this.seq } }); }
  release(rowId: string) {
    const next = { ...this.locks };
    delete next[rowId];
    this.set(next);
  }
  /** After a complete reload that started at `mark`: an unanswered request stays locked. */
  reloaded(mark: number) {
    this.set(Object.fromEntries(Object.entries(this.locks).filter(([, lock]) => lock.state === 'sending' || lock.seq > mark)));
  }

  private set(next: RequestLocks) {
    this.locks = next;
    this.listeners.forEach((listener) => listener());
  }
}

const byClient = new WeakMap<QueryClient, ConfirmationRequestLocks>();

export function useConfirmationRequestLocks() {
  const client = useQueryClient();
  let store = byClient.get(client);
  if (!store) {
    store = new ConfirmationRequestLocks();
    byClient.set(client, store);
  }
  const locks = useSyncExternalStore(store.subscribe, store.current, store.current);
  return { store, locks };
}
