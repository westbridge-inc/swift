import { useEffect, useMemo, useState } from 'react';
import type { GuestBasket } from './basket-storage';
const EVENT = 'swift-guest-basket';
export function useGuestBasket() {
  const [basket, setBasket] = useState<GuestBasket>({ version: 1, lines: [] });
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    let alive = true;
    const refresh = () => {
      void import('./basket-storage').then(({ readGuestBasket }) => {
        if (alive) { setBasket(readGuestBasket()); setLoaded(true); }
      });
    };
    refresh(); window.addEventListener(EVENT, refresh); window.addEventListener('storage', refresh);
    return () => { alive = false; window.removeEventListener(EVENT, refresh); window.removeEventListener('storage', refresh); };
  }, []);
  return useMemo(() => ({ ...basket, loaded }), [basket, loaded]);
}
