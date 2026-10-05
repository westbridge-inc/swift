import { useSyncExternalStore } from 'react';
import { webOrderingOpen } from './web-ordering';

const unchanging = () => () => {};

/**
 * [Item 7] The pre-launch switch, as the page the visitor is on sees it. The
 * server renders the closed state — it cannot see the address bar from here —
 * and the browser corrects it while hydrating, on the hosts that keep the
 * marketplace. A public page therefore never flashes an ordering button that
 * it does not have; staging shows its own for a moment later, which is fine.
 */
export function useWebOrderingOpen(): boolean {
  return useSyncExternalStore(unchanging, () => webOrderingOpen(window.location.host), () => false);
}
