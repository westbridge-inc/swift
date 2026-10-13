'use client';

import { useEffect, useRef, useState } from 'react';
import { placeDetails, placesAutocomplete, type Place } from '@/lib/customer';
import styles from '@/app/(app)/cart/cart.module.css';

/** A new delivery address: a pin chosen on Swift's map, never this device's location. */
export type NewAddress = { label: string; addressLine1: string; city: string; region: string; latitude: number; longitude: number };

/**
 * [W4 · W5] The checkout's "Add a delivery address" form. Only a customer with
 * no saved address opens it, so it loads on demand and keeps the checkout
 * light. Saving belongs to the checkout (it holds the order-attempt guards);
 * this form only finds the mapped destination and hands the fields over.
 */
export function NewAddressForm({ busy, onError, onSave }: {
  busy: boolean; onError: (_message: string | null) => void; onSave: (_address: NewAddress) => void;
}) {
  const [newAddr, setNewAddr] = useState({ label: '', addressLine1: '', city: '', region: '' });
  const [addressMatches, setAddressMatches] = useState<Place[]>([]);
  const [selectedPlace, setSelectedPlace] = useState<{ label: string; lat: number; lng: number } | null>(null);
  const [addressLookupBusy, setAddressLookupBusy] = useState(false);
  const addressLabelInput = useRef<HTMLInputElement | null>(null);
  useEffect(() => { addressLabelInput.current?.focus(); }, []);

  async function searchAddress() {
    if (addressLookupBusy || newAddr.addressLine1.trim().length < 3) return;
    setAddressLookupBusy(true);
    onError(null);
    setSelectedPlace(null);
    try {
      const matches = await placesAutocomplete(newAddr.addressLine1.trim());
      setAddressMatches(matches);
      if (!matches.length) onError('Swift found no map matches for that destination. Add more detail and search again.');
    } catch (lookupError) {
      setAddressMatches([]);
      onError(lookupError instanceof Error ? lookupError.message : 'Swift could not search the destination map.');
    } finally {
      setAddressLookupBusy(false);
    }
  }

  async function chooseAddressMatch(place: Place) {
    if (addressLookupBusy) return;
    setAddressLookupBusy(true);
    onError(null);
    try {
      const details = await placeDetails(place.placeId);
      setSelectedPlace({ label: details.label, lat: details.lat, lng: details.lng });
      setNewAddr((current) => ({ ...current, addressLine1: details.label }));
      setAddressMatches([]);
    } catch (lookupError) {
      setSelectedPlace(null);
      onError(lookupError instanceof Error ? lookupError.message : 'Swift could not confirm that mapped destination.');
    } finally {
      setAddressLookupBusy(false);
    }
  }

  function save() {
    if (!selectedPlace) return;
    onSave({
      label: newAddr.label.trim(),
      addressLine1: selectedPlace.label,
      city: newAddr.city.trim(),
      region: newAddr.region.trim(),
      latitude: selectedPlace.lat,
      longitude: selectedPlace.lng,
    });
  }

  return (
    <div className={styles.formStack}>
      <div className={styles.field}><label htmlFor="address-label" className={styles.label}>Address label</label><input ref={addressLabelInput} id="address-label" value={newAddr.label} onChange={(e) => setNewAddr({ ...newAddr, label: e.target.value })} className={styles.input} /></div>
      <div className={styles.field}>
        <label htmlFor="address-street" className={styles.label}>Search the delivery destination</label>
        <input
          id="address-street"
          autoComplete="street-address"
          value={newAddr.addressLine1}
          aria-describedby="address-map-help"
          onChange={(e) => {
            setNewAddr({ ...newAddr, addressLine1: e.target.value });
            setSelectedPlace(null);
            setAddressMatches([]);
          }}
          className={styles.input}
        />
        <p id="address-map-help" className={styles.stateCopy}>Choose a Swift map result below. The selected pin—not this device’s current location—sets the delivery fee and rider destination.</p>
      </div>
      <button type="button" onClick={() => void searchAddress()} disabled={addressLookupBusy || newAddr.addressLine1.trim().length < 3} className={`${styles.button} ${styles.buttonSecondary}`}>
        {addressLookupBusy ? 'Searching map…' : 'Find this destination on the map'}
      </button>
      {addressMatches.length > 0 ? (
        <div className={styles.panelStack} role="group" aria-label="Mapped address matches">
          {addressMatches.map((place) => (
            <button key={place.placeId} type="button" disabled={addressLookupBusy} onClick={() => void chooseAddressMatch(place)} className={`${styles.button} ${styles.buttonSecondary}`}>
              {place.primary}{place.secondary ? ` — ${place.secondary}` : ''}
            </button>
          ))}
        </div>
      ) : null}
      {selectedPlace ? <p className={styles.stateCopy} role="status">Mapped destination confirmed: {selectedPlace.label}</p> : null}
      <div className={styles.field}><label htmlFor="address-city" className={styles.label}>City or town</label><input id="address-city" autoComplete="address-level2" value={newAddr.city} onChange={(e) => setNewAddr({ ...newAddr, city: e.target.value })} className={styles.input} /></div>
      <div className={styles.field}><label htmlFor="address-region" className={styles.label}>Region</label><input id="address-region" autoComplete="address-level1" value={newAddr.region} onChange={(e) => setNewAddr({ ...newAddr, region: e.target.value })} className={styles.input} /></div>
      <button type="button" onClick={save} disabled={busy || !selectedPlace || !newAddr.label.trim() || !newAddr.city.trim() || !newAddr.region.trim()} className={`${styles.button} ${styles.buttonPrimary}`}>{busy ? 'Saving…' : 'Save mapped delivery address'}</button>
    </div>
  );
}
