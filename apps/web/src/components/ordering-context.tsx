'use client';
import { createContext, useContext, useState, type ReactNode } from 'react';
import { ChevronDown, MapPin } from 'lucide-react';
import { Sheet } from './sheet';
export type OrderingMode = 'DELIVERY' | 'PICKUP';
const Context = createContext<{ mode: OrderingMode; setMode: (_mode: OrderingMode) => void }>({ mode: 'DELIVERY' as OrderingMode, setMode: (_mode: OrderingMode) => undefined });
export const useOrderingContext = () => useContext(Context);
export function OrderingContextProvider({ children }: { children: ReactNode }) {
  const [mode, setMode] = useState<OrderingMode>('DELIVERY');
  return <Context.Provider value={{ mode, setMode }}>{children}</Context.Provider>;
}
export function OrderingContextBar() {
  const { mode, setMode } = useOrderingContext(); const [open, setOpen] = useState(false); const [area, setArea] = useState('');
  return <>
    <div className="sticky top-0 z-20 bg-[var(--swift-canvas)] py-3">
      <button onClick={() => setOpen(true)} className="flex min-h-11 max-w-full items-center gap-2 rounded-full border border-[var(--swift-border)] bg-[var(--swift-card)] px-4 text-sm" aria-label="Change delivery or pickup context">
        <MapPin size={18} aria-hidden className="text-[var(--swift-red)]" /><span className="font-semibold">{mode === 'PICKUP' ? 'Pickup' : 'Delivery'}</span><span className="truncate">{area || (mode === 'PICKUP' ? 'Choose a store' : 'Set your area')}</span><span className="text-[var(--swift-muted)]">· ASAP</span><ChevronDown size={16} aria-hidden />
      </button>
    </div>
    {open ? <Sheet labelledBy="ordering-context-title" onClose={() => setOpen(false)}>
      <h2 id="ordering-context-title" className="mb-4 text-xl font-semibold">Your order</h2>
      <fieldset className="flex gap-4"><legend className="mb-3 font-semibold">How would you like your order?</legend>{(['DELIVERY', 'PICKUP'] as const).map(value => <label key={value}><input type="radio" name="ordering-mode" checked={mode === value} onChange={() => setMode(value)} /> {value === 'DELIVERY' ? 'Delivery' : 'Pickup'}</label>)}</fieldset>
      <label className="my-4 block">{mode === 'PICKUP' ? 'Store or area' : 'Delivery area'}<input className="sw-input mt-2" value={area} maxLength={100} onChange={e => setArea(e.target.value)} /></label>
      <p className="mb-4 text-sm text-[var(--swift-muted)]">As soon as possible. The server confirms availability and the final total at checkout.</p>
      <button className="sw-btn-primary" onClick={() => setOpen(false)}>Done</button>
    </Sheet> : null}
  </>;
}
