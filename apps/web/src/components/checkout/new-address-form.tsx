'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { PinPicker, type ChosenPin } from '@/components/pin-picker/pin-picker';

/**
 * A new delivery address: the pin the customer placed on Swift's map, and the
 * words that help a rider find the door. The fields and their rules are the
 * phone app's (AddAddressScreen): label, street, apartment/landmark, city,
 * instructions — no region (optional on the server; the phone never sends one).
 */
export type NewAddress = {
  label: string;
  addressLine1: string;
  addressLine2?: string;
  city: string;
  latitude: number;
  longitude: number;
  instructions?: string;
};

/**
 * [W4 · W5 · WEB-PIN] The checkout's "Add a delivery address": a pin on the
 * map, then the address fields. It loads on demand, so the map's code never
 * weighs on the checkout itself; it uses the site's global classes only, so
 * this lazy chunk carries no CSS (a lazy chunk with CSS adds a CSS loader to
 * every page's first load). Saving belongs to the checkout (it holds the
 * order-attempt guards and asks the server for the quote); this form only
 * hands over a pinned address.
 *
 * Owner, 11 Oct: the old form searched the places provider only — on the test
 * server that knows delivery zones and saved addresses — so a customer could
 * not get any street onto the map, never got a quote, and could not order.
 */
export function NewAddressForm({ busy, onSave, onCancel }: {
  busy: boolean;
  onSave: (_address: NewAddress) => void;
  onCancel: () => void;
}) {
  const id = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  const [pin, setPin] = useState<ChosenPin | null>(null);
  const [label, setLabel] = useState('Home');
  const [street, setStreet] = useState('');
  // Until the customer types a street, it follows the CURRENT pin's name —
  // and is empty while that pin is unnamed or has no name (review S2: a moved
  // pin must never keep the previous spot's words; the phone never fills it).
  const streetTyped = useRef(false);
  const [landmark, setLandmark] = useState('');
  const [city, setCity] = useState('Georgetown');
  const [instructions, setInstructions] = useState('');

  useEffect(() => { heading.current?.focus(); }, []);

  function pinChanged(next: ChosenPin | null) {
    setPin(next);
    if (!streetTyped.current) setStreet(next?.named && next.address ? next.address.slice(0, 200) : '');
  }

  // The disabled button names the first thing still missing (the phone's grammar).
  const missing = !pin
    ? 'Place the pin on the map'
    : !pin.named
      ? 'Finding the address…'
      : label.trim().length < 2
      ? 'Give it a label'
      : street.trim().length < 3
        ? 'Add the street address'
        : city.trim().length < 2
          ? 'Add the city'
          : null;

  function save() {
    if (!pin || missing || busy) return;
    onSave({
      label: label.trim(),
      addressLine1: street.trim(),
      ...(landmark.trim() ? { addressLine2: landmark.trim() } : {}),
      city: city.trim(),
      latitude: pin.latitude,
      longitude: pin.longitude,
      ...(instructions.trim() ? { instructions: instructions.trim() } : {}),
    });
  }

  return (
    <section className="grid gap-3" aria-labelledby={`${id}-title`}>
      <h3 ref={heading} id={`${id}-title`} tabIndex={-1} className="sw-heading outline-none">Pin your delivery address</h3>
      <p className="sw-caption m-0">
        Put the pin on your door. The pin sets the delivery fee and where your rider goes; the words below help them find you.
      </p>
      <PinPicker mapLabel="Delivery pin map" onChange={pinChanged} />
      <div>
        <label htmlFor={`${id}-label`} className="sw-field-label">Label</label>
        <input id={`${id}-label`} className="sw-input" value={label} maxLength={50} placeholder="Home, Work…" onChange={(event) => setLabel(event.target.value)} />
      </div>
      <div>
        <label htmlFor={`${id}-street`} className="sw-field-label">Street address</label>
        <input
          id={`${id}-street`}
          className="sw-input"
          value={street}
          maxLength={200}
          autoComplete="street-address"
          placeholder="Lot and street"
          onChange={(event) => { streetTyped.current = true; setStreet(event.target.value); }}
        />
      </div>
      <div>
        <label htmlFor={`${id}-landmark`} className="sw-field-label">Apt / landmark (optional)</label>
        <input id={`${id}-landmark`} className="sw-input" value={landmark} maxLength={200} placeholder="Near…" onChange={(event) => setLandmark(event.target.value)} />
      </div>
      <div>
        <label htmlFor={`${id}-city`} className="sw-field-label">City / Town</label>
        <input id={`${id}-city`} className="sw-input" value={city} maxLength={100} autoComplete="address-level2" onChange={(event) => setCity(event.target.value)} />
      </div>
      <div>
        <label htmlFor={`${id}-instructions`} className="sw-field-label">Delivery instructions (optional)</label>
        <input id={`${id}-instructions`} className="sw-input" value={instructions} maxLength={500} placeholder="Gate code, dog, etc." onChange={(event) => setInstructions(event.target.value)} />
      </div>
      <button type="button" onClick={save} disabled={busy || missing !== null} className="sw-btn sw-btn-block">
        {busy ? 'Saving…' : missing ?? 'Save address'}
      </button>
      <button type="button" onClick={onCancel} disabled={busy} className="sw-btn sw-btn-outline sw-btn-block">Cancel</button>
    </section>
  );
}
