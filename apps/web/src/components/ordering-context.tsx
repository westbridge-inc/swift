'use client';
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { readCheckoutAttempt } from '@/lib/customer';

export type OrderingMode = 'DELIVERY' | 'PICKUP';
const STORAGE_KEY = 'swift_ordering_mode';
const Context = createContext<{ mode: OrderingMode; setMode: (_mode: OrderingMode) => boolean }>({ mode: 'DELIVERY', setMode: () => false });
export const useOrderingContext = () => useContext(Context);

/** The ordering pages: where "Delivery or Pickup · ASAP" means something. */
export function showsOrderingContext(pathname: string): boolean {
  return pathname === '/' || pathname === '/cart' || pathname === '/checkout' || pathname === '/market' || pathname === '/explore'
    || pathname === '/order/browse' || pathname === '/order/search' || pathname.startsWith('/store/');
}

/**
 * Delivery or pickup for this visit, chosen once and kept for the tab (a
 * reload keeps it; another tab starts on delivery). The server prices and
 * accepts either; nothing here is a price.
 */
export function OrderingContextProvider({ children }: { children: ReactNode }) {
  const [mode, setModeState] = useState<OrderingMode>('DELIVERY');
  useEffect(() => {
    try { if (sessionStorage.getItem(STORAGE_KEY) === 'PICKUP') setModeState('PICKUP'); } catch { /* storage can be blocked */ }
  }, []);
  /** [W5 · review S3] Delivery or pickup is part of the order request, so no
   *  surface (the bar, the store panel, the checkout) changes it while an
   *  earlier order's outcome is unknown. False when refused. */
  const setMode = useCallback((next: OrderingMode) => {
    if (readCheckoutAttempt()) return false;
    setModeState(next);
    try { sessionStorage.setItem(STORAGE_KEY, next); } catch { /* the choice still holds for this page */ }
    return true;
  }, []);
  return <Context.Provider value={{ mode, setMode }}>{children}</Context.Provider>;
}
