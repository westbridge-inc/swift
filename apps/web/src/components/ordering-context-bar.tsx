'use client';
import { lazy, Suspense, useState } from 'react';
import { ChevronDown, MapPin } from 'lucide-react';
import { useOrderingContext } from './ordering-context';
const Sheet = lazy(() => import('./sheet').then(module => ({ default: module.Sheet })));

/** "Delivery · address at checkout · ASAP" — the order's context, one tap to change. */
export function OrderingContextBar() {
  const { mode, setMode } = useOrderingContext(); const [open, setOpen] = useState(false);
  const pickup = mode === 'PICKUP';
  return <>
    <div className="sticky top-0 z-20 bg-[var(--swift-canvas)] py-3">
      <button type="button" onClick={() => setOpen(true)} className="flex min-h-11 max-w-full items-center gap-2 rounded-full border border-[var(--swift-border)] bg-[var(--swift-card)] px-4 text-sm" aria-label={`${pickup ? 'Pickup from the store' : 'Delivery, address at checkout'}, as soon as possible. Change delivery or pickup`}>
        <MapPin size={18} aria-hidden className="text-[var(--swift-red)]" /><span className="font-semibold">{pickup ? 'Pickup' : 'Delivery'}</span><span className="truncate">{pickup ? 'from the store' : 'address at checkout'}</span><span className="text-[var(--swift-muted)]">· ASAP</span><ChevronDown size={16} aria-hidden />
      </button>
    </div>
    {open ? <Suspense fallback={<p role="status">Loading delivery or pickup…</p>}><Sheet labelledBy="ordering-context-title" onClose={() => setOpen(false)}>
      <h2 id="ordering-context-title" className="mb-4 text-xl font-semibold">Delivery or pickup</h2>
      <fieldset className="grid gap-3"><legend className="mb-1 font-semibold">How would you like your order?</legend>
        {(['DELIVERY', 'PICKUP'] as const).map(value => <label key={value} className="flex min-h-11 items-start gap-3">
          <input type="radio" name="ordering-mode" className="mt-1" checked={mode === value} onChange={() => setMode(value)} />
          <span><span className="block font-semibold">{value === 'DELIVERY' ? 'Delivery' : 'Pickup'}</span>
            <span className="block text-sm text-[var(--swift-muted)]">{value === 'DELIVERY' ? 'A rider brings it to the address you choose at checkout.' : 'Collect it from the store yourself. No delivery fee.'}</span></span>
        </label>)}
      </fieldset>
      <p className="my-4 text-sm text-[var(--swift-muted)]">Orders are prepared as soon as possible. Swift’s server confirms the store, the price and the total before you place the order.</p>
      <button type="button" className="sw-btn-primary" onClick={() => setOpen(false)}>Done</button>
    </Sheet></Suspense> : null}
  </>;
}
