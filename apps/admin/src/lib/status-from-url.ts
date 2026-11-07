import { useEffect } from 'react';

/** [ADMIN-AUDIT S2-1 · REVIEW-F #2152 S4-4] A page opened from Today's "Needs you" lands on the tab that lists the
 *  row (`?status=REFUND_DUE`). Read once, after mount (the page is pre-rendered without it); anything not a tab of
 *  this page is ignored. */
export function useStatusFromUrl<T extends string>(tabs: readonly T[], setTab: (_tab: T) => void): void {
  useEffect(() => {
    const wanted = new URLSearchParams(window.location.search).get('status');
    const tab = tabs.find((t) => t === wanted);
    if (tab) setTab(tab);
    // Once, on arrival: the tabs are a constant and the setter is stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
