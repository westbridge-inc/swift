'use client';
import { createContext, useContext, useState, type ReactNode } from 'react';
export type OrderingMode = 'DELIVERY' | 'PICKUP';
const Context = createContext<{ mode: OrderingMode; setMode: (_mode: OrderingMode) => void }>({ mode: 'DELIVERY' as OrderingMode, setMode: (_mode: OrderingMode) => undefined });
export const useOrderingContext = () => useContext(Context);
export function OrderingContextProvider({ children }: { children: ReactNode }) {
  const [mode, setMode] = useState<OrderingMode>('DELIVERY');
  return <Context.Provider value={{ mode, setMode }}>{children}</Context.Provider>;
}
