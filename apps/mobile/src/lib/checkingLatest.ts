import { useState } from 'react';

// ---------------------------------------------------------------------------
// [SPEED 30 Oct · owner] Money is never shown from memory as if it were Swift's
// answer. A business screen opened again draws its last answer at once (the
// cache keeps it, lib/appQueryPolicy BUSINESS_KEEP_MS) and re-reads behind it;
// while that re-read is on its way, money on the screen says it is being
// checked (and the weekly fee's Pay waits for the answer). True only for an
// answer from before the screen opened: its own polls afterwards never flash it.
// The same rule as the web console (apps/web/src/components/checking-latest.tsx).
// ---------------------------------------------------------------------------

export type ReadState = { data: unknown; isFetching: boolean; dataUpdatedAt: number };

export function checkingLatest(read: ReadState, openedAt: number): boolean {
  return read.data !== undefined && read.isFetching && read.dataUpdatedAt < openedAt;
}

export function useCheckingLatest(read: ReadState): boolean {
  const [openedAt] = useState(() => Date.now());
  return checkingLatest(read, openedAt);
}
