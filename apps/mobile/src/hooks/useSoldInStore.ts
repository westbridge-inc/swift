import { useEffect, useState } from 'react';
import { createSoldInStore, type SaleFailure, type SaleView } from '../lib/inStoreSale';
import { errorMessage } from '../lib/apiError';

// [IN-STORE-SALE] The app's ONE "Sold in store" line of taps (lib/inStoreSale): module-level, so a tap is never
// dropped when the menu screen that made it closes, and the menu list and any other screen show the same count.
// The sender (hooks/vendorops useSoldInStoreSender) is installed by the row's controls.
export const soldInStore = createSoldInStore();

/** No answer (offline, a timeout, a server error) may have landed; only a 4xx is the server saying no. */
export function phoneSaleFailure(error: unknown): SaleFailure {
  const status = (error as { response?: { status?: unknown } } | null)?.response?.status;
  if (typeof status === 'number' && status >= 400 && status < 500) {
    return { refused: errorMessage(error, 'Swift couldn’t save that. Check the count and try again.') };
  }
  return 'noAnswer';
}

/**
 * What one item's row shows of its in-store taps. It redraws only when THAT item's taps change (a tap on another
 * row draws nothing here).
 */
export function useSoldInStoreRow(itemId: string): SaleView {
  const [, redraw] = useState(0);
  const drawn = soldInStore.viewKey(itemId);
  useEffect(() => {
    let seen = drawn;
    const check = () => {
      const now = soldInStore.viewKey(itemId);
      if (now !== seen) { seen = now; redraw((n) => n + 1); }
    };
    const off = soldInStore.subscribe(check);
    check(); // a tap between this row's draw and its subscription is drawn too
    return off;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `drawn` is read once, at subscription; later draws come from `check`
  }, [itemId]);
  return soldInStore.view(itemId);
}
