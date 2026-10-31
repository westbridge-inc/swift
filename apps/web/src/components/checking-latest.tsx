'use client';

import { useState } from 'react';

/**
 * [SPEED 30 Oct · owner] Money is never shown from memory as if it were Swift's
 * answer. A page opened again draws its last answer at once (the console keeps
 * it) and re-reads in the background; while that re-read is on its way, money
 * on the page says it is being checked. True only for an answer older than the
 * page's opening: the page's own polls afterwards do not flash the line.
 */
export function useCheckingLatest(read: { data: unknown; isFetching: boolean; dataUpdatedAt: number }): boolean {
  const [openedAt] = useState(() => Date.now());
  return read.data !== undefined && read.isFetching && read.dataUpdatedAt < openedAt;
}

export function CheckingLatest({ show }: { show: boolean }) {
  return show ? <p role="status" className="text-sm text-[var(--swift-muted)]">Checking for the latest…</p> : null;
}
