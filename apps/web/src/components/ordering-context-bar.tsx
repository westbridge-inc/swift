'use client';
import { Suspense, useState } from 'react';
import Link from 'next/link';
import { ChevronDown, MapPin } from 'lucide-react';
import { useOrderingContext } from './ordering-context';
import { MODE_LOCKED } from '@/lib/ordering-mode-lock';
import { lazyRetry } from '@/lib/chunk-retry';
const Sheet = lazyRetry(() => import('./sheet').then(module => ({ default: module.Sheet })));

/**
 * "Delivery · address at checkout · ASAP" — the order's context, one tap to change.
 * On Home it is the page's one place control (inline in Home's top row): it
 * shows the address the customer delivers to, which is changed from its sheet,
 * and a guest finds the stores near them there. Pickup shows no address.
 */
export function OrderingContextBar({ inline = false, deliverTo, addressHref, nearMe }: {
  inline?: boolean;
  /** The saved address a signed-in customer delivers to (Home). */
  deliverTo?: string | null;
  /** Where that address is added or changed (Home, signed in). */
  addressHref?: string;
  /** A guest's "show stores near me" (Home). */
  nearMe?: { busy: boolean; on: boolean; find: () => void };
} = {}) {
  const { mode, setMode } = useOrderingContext(); const [open, setOpen] = useState(false); const [locked, setLocked] = useState(false);
  const pickup = mode === 'PICKUP';
  const where = pickup ? 'from the store' : deliverTo || 'address at checkout';
  const close = () => { setOpen(false); setLocked(false); };
  // Inline (Home's top row, which on a phone also holds the menu and the
  // profile or Sign in) the phone pill shows the address itself, like the
  // phone app's location pill, or just "Delivery" before there is one;
  // "Delivery", "address at checkout" and "ASAP" show on wider screens.
  // [WEB-LAUNCH-CHECK F4] The pill is named by its own words (no aria-label):
  // words a phone hides are visually hidden, not removed, so they stay in the
  // name, and what a voice-control user sees is what they can say.
  const phoneHides = (hide: boolean | undefined) => (hide ? ' sr-only wide:not-sr-only' : '');
  const trigger = (
    <button type="button" onClick={() => setOpen(true)} className={`flex min-h-11 max-w-full items-center gap-2 rounded-full border border-[var(--swift-border)] bg-[var(--swift-card)] px-4 text-sm${inline ? ' min-w-0' : ''}`}>
      <MapPin size={18} aria-hidden className="flex-none text-[var(--swift-red)]" /><span className={`font-semibold${phoneHides(inline && !pickup && !!deliverTo)}`}>{pickup ? 'Pickup' : 'Delivery'}</span>{' '}<span className={`truncate${phoneHides(inline && !pickup && !deliverTo)}`}>{where}</span>{' '}<span className={`flex-none text-[var(--swift-muted)]${phoneHides(inline)}`}><span aria-hidden>· </span>ASAP</span><span className="sr-only">. Change delivery or pickup</span><ChevronDown size={16} aria-hidden className="flex-none" />
    </button>
  );
  return <>
    {inline ? trigger : <div className="sticky top-0 z-20 bg-[var(--swift-canvas)] py-3">{trigger}</div>}
    {open ? <Suspense fallback={<p role="status">Loading delivery or pickup…</p>}><Sheet labelledBy="ordering-context-title" onClose={close} className="bg-[var(--swift-card)] px-6 pb-6 pt-5">
      <h2 id="ordering-context-title" className="mb-4 text-xl font-semibold">Delivery or pickup</h2>
      <fieldset className="grid gap-3"><legend className="mb-1 font-semibold">How would you like your order?</legend>
        {(['DELIVERY', 'PICKUP'] as const).map(value => <label key={value} className="flex min-h-11 items-start gap-3">
          <input type="radio" name="ordering-mode" className="mt-1" checked={mode === value} onChange={() => setLocked(!setMode(value))} />
          <span><span className="block font-semibold">{value === 'DELIVERY' ? 'Delivery' : 'Pickup'}</span>
            <span className="block text-sm text-[var(--swift-muted)]">{value === 'DELIVERY' ? 'A rider brings it to the address you choose at checkout.' : 'Collect it from the store yourself. No delivery fee.'}</span></span>
        </label>)}
      </fieldset>
      {locked ? <p role="alert" className="mt-3">{MODE_LOCKED}</p> : null}
      {addressHref && !pickup ? <Link href={addressHref} className="sw-btn sw-btn-md sw-btn-block sw-btn-outline mt-4">{deliverTo ? 'Change delivery address' : 'Add a delivery address'}</Link> : null}
      {nearMe ? <button type="button" className="sw-btn sw-btn-md sw-btn-block sw-btn-outline mt-4" disabled={nearMe.busy} onClick={() => { close(); nearMe.find(); }}>{nearMe.busy ? 'Finding you…' : nearMe.on ? 'Showing stores near you' : 'Show stores near me'}</button> : null}
      <p className="my-4 text-sm text-[var(--swift-muted)]">Orders are prepared as soon as possible. We confirm the store, price and total before you place your order.</p>
      <button type="button" className="sw-btn sw-btn-block" onClick={close}>Done</button>
    </Sheet></Suspense> : null}
  </>;
}
