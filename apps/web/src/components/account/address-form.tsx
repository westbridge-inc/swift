'use client';

import { lazy, Suspense, useRef, useState, type FormEvent } from 'react';
import { accountApi, type Address, type AddressInput } from './account-api';
import { buttonClass, fieldClass, secondaryClass } from './account-frame';
import type { ChosenPin, PinPoint } from '@/components/pin-picker/pin-picker';

// [PINS · row 107] The website's one "add or edit a saved address" form, on the
// account's Saved addresses and on the Delivery addresses page that "Change
// delivery address" opens. The pin is the one customer pin picker (checkout and
// Send a parcel use it too), loaded on demand: a person who only renames an
// address or changes a gate code never downloads the map.
const PinPicker = lazy(() => import('@/components/pin-picker/pin-picker').then((module) => ({ default: module.PinPicker })));

/** A saved address's stored point, when it is a usable one. */
function storedPin(address?: Address): PinPoint | null {
  if (!address) return null;
  const latitude = Number(address.latitude);
  const longitude = Number(address.longitude);
  const usable = Number.isFinite(latitude) && Math.abs(latitude) <= 90 && Number.isFinite(longitude) && Math.abs(longitude) <= 180
    && !(latitude === 0 && longitude === 0);
  return usable ? { latitude, longitude } : null;
}

/**
 * [PINS · row 107] Add or edit a saved address — the phone app's rule
 * (AddAddressScreen + LocationPickerScreen): the stored point IS the pin the
 * person placed on the map, and the words are theirs, to help a rider find the
 * door. A new address is pinned on the map; an edited one keeps its pin until
 * the person chooses to move it, so changing a gate code never needs the map.
 * Changing the street, city or region words never moves or drops the pin.
 */
export function AddressForm({ address, onSaved, onCancel, fixedDefault }: {
  address?: Address;
  onSaved: (_saved: Address) => Promise<void>;
  onCancel: () => void;
  /** Set by a page that decides itself whether a NEW address becomes the default (no checkbox then). */
  fixedDefault?: boolean;
}) {
  const [form, setForm] = useState({ label: address?.label ?? 'Home', addressLine1: address?.addressLine1 ?? '', addressLine2: address?.addressLine2 ?? '', city: address?.city ?? 'Georgetown', region: address?.region ?? 'Demerara-Mahaica', instructions: address?.instructions ?? '' });
  const [stored] = useState(() => storedPin(address));
  // Without a usable stored pin (a new address), the map is the first step.
  const [adjusting, setAdjusting] = useState(stored === null);
  const [picked, setPicked] = useState<ChosenPin | null>(null);
  // A new address's street follows the CURRENT pin's name until the person
  // types one (the checkout's rule); an edited address's street is already
  // the person's words and a pin never replaces them.
  const streetTyped = useRef(Boolean(address));
  const [isDefault, setIsDefault] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sending = useRef(false);
  function edit(patch: Partial<typeof form>) {
    setForm((old) => ({ ...old, ...patch })); setError(null);
  }
  function pinChanged(next: ChosenPin | null) {
    setPicked(next);
    if (!streetTyped.current) setForm((old) => ({ ...old, addressLine1: next?.named && next.address ? next.address.slice(0, 200) : '' }));
  }
  const pin: PinPoint | null = adjusting ? picked : stored;
  // The disabled Save says, under it, the first thing still missing.
  const missing = !pin
    ? 'Place the pin on the map.'
    : adjusting && !picked?.named
      ? 'Finding the address…'
      : !form.label.trim()
        ? 'Give it a label.'
        : !form.addressLine1.trim() || form.addressLine1.length > 200
          ? 'Add the street address.'
          : !form.city.trim()
            ? 'Add the city.'
            : null;
  async function save(event: FormEvent) {
    event.preventDefault();
    if (missing || !pin || sending.current) return;
    // A search inside the map is not the Save action.
    if ((event.nativeEvent as SubmitEvent).submitter?.getAttribute('data-save-address') !== 'true') return;
    sending.current = true; setBusy(true); setError(null);
    const body: AddressInput = { ...form, label: form.label.trim(), addressLine1: form.addressLine1.trim(), city: form.city.trim(), latitude: pin.latitude, longitude: pin.longitude };
    try {
      const saved = address ? await accountApi.updateAddress(address.id, body)
        : await accountApi.addAddress({ ...body, isDefault: fixedDefault ?? isDefault });
      await onSaved(saved);
    } catch (e) { setError((e as Error).message); }
    finally { sending.current = false; setBusy(false); }
  }
  return <form onSubmit={save} className="space-y-4 sw-card p-5">
    <h2 className="font-bold">{address ? 'Edit address' : 'Add address'}</h2>
    <fieldset disabled={busy} className="space-y-3">
      {adjusting ? <div className="space-y-3">
        <p className="text-sm text-[var(--swift-muted)]">Put the pin on the door. The pin is where your rider goes and what the delivery fee is measured to; the words below help them find you.</p>
        <Suspense fallback={<p role="status">Loading the map…</p>}>
          <PinPicker mapLabel="Address pin map" start={stored} onChange={pinChanged} />
        </Suspense>
        {stored && <button type="button" className={secondaryClass} onClick={() => { setAdjusting(false); setPicked(null); }}>Keep the saved pin</button>}
      </div> : stored && <div className="space-y-2">
        <p className="text-sm text-[var(--swift-muted)]">Pin on the map: Latitude {stored.latitude.toFixed(5)}, Longitude {stored.longitude.toFixed(5)}</p>
        <button type="button" className={secondaryClass} onClick={() => { setPicked(null); setAdjusting(true); }}>Move the pin</button>
      </div>}
      <label className="block space-y-1"><span>Label</span><input className={fieldClass} required maxLength={50} value={form.label} onChange={(e) => edit({ label: e.target.value })} /></label>
      <label className="block space-y-1"><span>Street address</span><input className={fieldClass} required maxLength={200} autoComplete="street-address" placeholder="Lot and street" value={form.addressLine1} onChange={(e) => { streetTyped.current = true; edit({ addressLine1: e.target.value }); }} /></label>
      <label className="block space-y-1"><span>Apt / landmark (optional)</span><input className={fieldClass} maxLength={200} value={form.addressLine2} onChange={(e) => edit({ addressLine2: e.target.value })} /></label>
      <label className="block space-y-1"><span>City / town</span><input className={fieldClass} required maxLength={100} value={form.city} onChange={(e) => edit({ city: e.target.value })} /></label>
      <label className="block space-y-1"><span>Region</span><input className={fieldClass} maxLength={100} value={form.region} onChange={(e) => edit({ region: e.target.value })} /></label>
      <label className="block space-y-1"><span>Delivery instructions (optional)</span><input className={fieldClass} maxLength={500} value={form.instructions} onChange={(e) => edit({ instructions: e.target.value })} /></label>
      {!address && fixedDefault === undefined && <label className="flex min-h-11 items-center gap-3"><input type="checkbox" checked={isDefault} onChange={(e) => setIsDefault(e.target.checked)} />Make this my default address</label>}
    </fieldset>
    {missing && <p className="text-sm text-[var(--swift-muted)]">{missing}</p>}
    {error && <p role="alert">{error}</p>}
    <div className="flex gap-2"><button data-save-address="true" className={buttonClass} disabled={busy || missing !== null}>{busy ? 'Saving…' : 'Save address'}</button><button type="button" className={secondaryClass} disabled={busy} onClick={onCancel}>Cancel</button></div>
  </form>;
}
