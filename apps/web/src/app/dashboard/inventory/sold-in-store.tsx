'use client';

import { useSyncExternalStore } from 'react';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { ApiRequestError } from '@/lib/auth';
import { storeKey } from '@/lib/store-scope';
import { sellInStore, undoInStoreSale } from '@/lib/stock-adjust';
import type { CatalogItem } from '@/lib/vendor-api';
// The app's own line of taps and words (a plain file with no imports, used as is: the website copies the app).
import { SOLD_IN_STORE, createSoldInStore, type SaleAnswer, type SaleFailure } from '../../../../../mobile/src/lib/inStoreSale';

// [IN-STORE-SALE · owner 27 Oct] "Sold in store −1" on a tracked item's row of the Products page, as in the app
// (VendorMenuScreen SoldInStoreControls): one tap takes one sold in person off the Swift stock. The count moves at the
// tap and settles on the server's answer; taps add up; only that item waits; "Sold 1 in store · Undo" for a few
// seconds; a refusal says why; no answer offers "Try again" (the same tap, the same key). This file is part of the
// page's tools chunk (fetched in the background at mount), so the page's first load does not carry it.

/** The website's ONE line of taps: a tap is never dropped by a row drawing again. */
export const soldInStore = createSoldInStore();

/** Only a 4xx is the server saying no; no answer, a timeout or a server error may have landed. */
export function webSaleFailure(error: unknown): SaleFailure {
  if (error instanceof ApiRequestError && error.status >= 400 && error.status < 500 && error.code !== 'UNREACHABLE') return { refused: error.message };
  return 'noAnswer';
}

let settleTimer: ReturnType<typeof setTimeout> | null = null;
/** ONE re-read of the list after a burst of taps, once none is on its way (landing first, it would show an old count). */
function rereadSoon(queryClient: QueryClient, storeId: string | null, delay = 800) {
  if (settleTimer) clearTimeout(settleTimer);
  settleTimer = setTimeout(() => {
    settleTimer = null;
    if (soldInStore.inFlight()) { rereadSoon(queryClient, storeId, delay); return; }
    void queryClient.invalidateQueries({ queryKey: storeKey(storeId, 'items') });
  }, delay);
}

function useSender(storeId: string | null) {
  const queryClient = useQueryClient();
  soldInStore.setSender({
    newKey: () => crypto.randomUUID(),
    send: (itemId, op) => (op.kind === 'sale' ? sellInStore(itemId, op.key) : undoInStoreSale(itemId, op.saleKey))
      .then((body) => (body as { data?: SaleAnswer } | undefined)?.data),
    // The answer goes into the list of the store the tap was made in (its own cache), never another's.
    answered: (itemId, answer, scope) => {
      const tappedIn = (scope as { storeId: string | null } | undefined)?.storeId ?? null;
      queryClient.setQueryData<CatalogItem[]>(storeKey(tappedIn, 'items', 'all'), (rows) => rows?.map((row) => (row.id === itemId ? {
        ...row,
        ...(typeof answer?.stockQuantity === 'number' ? { stockQuantity: answer.stockQuantity } : {}),
        ...(typeof answer?.isAvailable === 'boolean' ? { isAvailable: answer.isAvailable } : {}),
      } : row)));
      rereadSoon(queryClient, tappedIn);
    },
    reread: () => rereadSoon(queryClient, storeId),
    classify: webSaleFailure,
  });
  return {
    tap: (itemId: string) => {
      // A read of the list already on its way left before this tap: landing, it would show the count from before it.
      void queryClient.cancelQueries({ queryKey: storeKey(storeId, 'items', 'all') });
      soldInStore.tap(itemId, { storeId });
    },
    undo: (itemId: string) => soldInStore.undo(itemId, { storeId }),
    retry: (itemId: string) => soldInStore.retry(itemId),
  };
}

/** The row's stock: "N in stock · Adjust stock" (N moved by taps not answered yet), then the app's in-store controls. */
export function SaleStock({ item, storeId, onAdjust }: { item: CatalogItem; storeId: string | null; onAdjust: () => void }) {
  const taps = useSender(storeId);
  // Redraws only when THIS item's taps change.
  useSyncExternalStore(soldInStore.subscribe, () => soldInStore.viewKey(item.id), () => '');
  const sale = soldInStore.view(item.id);
  const shown = soldInStore.shown(item.id, item.stockQuantity ?? 0);
  return (
    <>
      <button type="button" onClick={onAdjust} className="sw-link-btn min-h-8">{shown} in stock · Adjust stock</button>
      <button
        type="button"
        onClick={() => taps.tap(item.id)}
        disabled={shown <= 0}
        title={SOLD_IN_STORE.a11yHint}
        className="min-h-8 rounded-full bg-[var(--swift-red-50)] px-3 text-[13px] font-semibold text-[var(--swift-red-600)] disabled:opacity-45"
      >
        {SOLD_IN_STORE.button}
      </button>
      {sale.sold > 0 && (
        <span role="status">
          {SOLD_IN_STORE.sold(sale.sold)} ·{' '}
          <button type="button" onClick={() => taps.undo(item.id)} className="min-h-8 font-semibold text-[var(--swift-red)]">{SOLD_IN_STORE.undo}</button>
        </span>
      )}
      {sale.stalled && (
        <span role="alert" className="text-[var(--swift-red)]">
          {SOLD_IN_STORE.notSent(sale.unsent)}{' '}
          <button type="button" onClick={() => taps.retry(item.id)} className="min-h-8 font-semibold underline">{SOLD_IN_STORE.tryAgain}</button>
        </span>
      )}
      {sale.notice && <span role="alert" className="font-semibold text-[var(--swift-red)]">{sale.notice}</span>}
    </>
  );
}
