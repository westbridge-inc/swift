import { useEffect, useMemo, useState } from 'react';
import type { GuestBasket } from './basket-storage';
const EVENT = 'swift-guest-basket';
/** The basket code once it has loaded in this window (only ever inside an effect, so never on
 *  the server and never before hydration). A later mount, such as the checkout's basket, reads
 *  the basket in its first render and never draws "empty" for a moment (#1958 review S4-2). */
let storage: typeof import('./basket-storage') | null = null;
export function useGuestBasket() {
  const [basket, setBasket] = useState<GuestBasket>(() => storage?.readGuestBasket() ?? { version: 1, lines: [] });
  const [loaded, setLoaded] = useState(() => storage !== null);
  useEffect(() => {
    let alive = true;
    const refresh = () => {
      void import('./basket-storage').then((module) => {
        storage = module;
        if (alive) { setBasket(module.readGuestBasket()); setLoaded(true); }
      });
    };
    refresh(); window.addEventListener(EVENT, refresh); window.addEventListener('storage', refresh);
    return () => { alive = false; window.removeEventListener(EVENT, refresh); window.removeEventListener('storage', refresh); };
  }, []);
  return useMemo(() => ({ ...basket, loaded }), [basket, loaded]);
}
