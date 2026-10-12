'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { getAddresses } from '@/lib/customer';
import type { PickedPlace } from '@/lib/place';
import { PinPicker, type ChosenPin, type PinPoint, type SavedPin } from './pin-picker';

/** The phone's name for a pin no street lookup could name (PinConfirmScreen). */
export const DROPPED_PIN = 'Dropped pin';

/**
 * [WEB-PIN] One end of a trip — a parcel's pickup or drop-off — pinned on the
 * map, as the phone's "Set location on map" does. The pin is handed back as a
 * PickedPlace whose label IS the text the field then shows, so the field's own
 * rule (the text in the box is the place) holds for a pinned place too.
 * The customer's saved addresses are offered as starting points. Global
 * classes only, like the picker: no CSS of its own in this lazy chunk.
 */
export function PlacePinPanel({ title, mapLabel, start, onUse, onCancel }: {
  title: string;
  mapLabel: string;
  start: PinPoint | null;
  onUse: (_place: PickedPlace) => void;
  onCancel: () => void;
}) {
  const id = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  const [pin, setPin] = useState<ChosenPin | null>(null);
  const [saved, setSaved] = useState<SavedPin[]>([]);

  useEffect(() => {
    heading.current?.focus();
    let live = true;
    // Starting points only: without them the map, search and location still work.
    getAddresses({ redirectOnExpired: false })
      .then((rows) => { if (live) setSaved(Array.isArray(rows) ? rows as SavedPin[] : []); })
      .catch(() => undefined);
    return () => { live = false; };
  }, []);

  function use() {
    if (!pin) return;
    const label = pin.address?.trim().slice(0, 200) || DROPPED_PIN;
    onUse({ label, lat: pin.latitude, lng: pin.longitude, placeId: `pin:${pin.latitude.toFixed(6)},${pin.longitude.toFixed(6)}` });
  }

  return (
    <section className="grid gap-3" aria-labelledby={`${id}-title`}>
      <h3 ref={heading} id={`${id}-title`} tabIndex={-1} className="sw-heading outline-none">{title}</h3>
      <PinPicker mapLabel={mapLabel} start={start} saved={saved} onChange={setPin} />
      <div className="flex gap-2">
        <button type="button" className="sw-btn sw-btn-md flex-1" disabled={!pin} onClick={use}>Use this pin</button>
        <button type="button" className="sw-btn sw-btn-outline sw-btn-md flex-1" onClick={onCancel}>Cancel</button>
      </div>
    </section>
  );
}
