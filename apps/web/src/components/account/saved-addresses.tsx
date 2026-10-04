'use client';

import { useRef, useState, type FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useCustomerSession } from '@/components/customer-session';
import { accountApi, type Address, type AddressInput } from './account-api';
import { AccountFrame, buttonClass, fieldClass, secondaryClass, useAccountQuery } from './account-frame';
import { LocationField } from '@/components/location-field';
import { DataUnavailable } from '@/components/data-unavailable';
import { currentFix } from '@/lib/geolocate';
import { acceptFix, addressKey, type PickedPlace } from '@/lib/place';

export function SavedAddresses() {
  const addresses = useAccountQuery('addresses', accountApi.addresses);
  const queryClient = useQueryClient();
  const session = useCustomerSession();
  async function refreshAddresses() {
    await Promise.all([addresses.refetch(), queryClient.invalidateQueries({ queryKey: ['customer', 'addresses', session.scope] })]);
  }
  async function savedAddress(saved: Address) {
    const queryKey = ['account', session.scope, session.epoch, 'addresses'];
    await queryClient.cancelQueries({ queryKey, exact: true });
    queryClient.setQueryData<Address[]>(queryKey, (rows = []) => {
      const others = rows.filter((row) => row.id !== saved.id);
      return [...others.map((row) => saved.isDefault ? { ...row, isDefault: false } : row), saved];
    });
    setEditing(null);
    await refreshAddresses();
  }
  const [editing, setEditing] = useState<Address | 'new' | null>(null);
  const [removing, setRemoving] = useState<Address | null>(null);
  const [busy, setBusy] = useState(false);
  const sending = useRef(false);
  const [error, setError] = useState<string | null>(null);
  async function change(action: () => Promise<unknown>) {
    if (sending.current) return;
    sending.current = true; setBusy(true); setError(null);
    try {
      await action(); setRemoving(null);
      // Read the server's default, including its promotion after a deletion.
      await refreshAddresses();
    } catch (e) { setError((e as Error).message); }
    finally { sending.current = false; setBusy(false); }
  }
  return <AccountFrame title="Saved addresses">
    <p className="text-sm text-[var(--swift-muted)]">Your default is used when your cart has no delivery address selected.</p>
    {addresses.isError ? <DataUnavailable what="your saved addresses" error={addresses.error} onRetry={() => void addresses.refetch()} />
      : !addresses.data ? <p role="status">Loading your addresses…</p>
      : addresses.data.length === 0 ? <p>No addresses yet. Add where deliveries should go.</p>
      : <ul className="space-y-3">{addresses.data.map((address) => <li key={address.id} className="space-y-3 sw-card p-4">
        <h2 className="font-bold">{address.label} {address.isDefault && <span className="ml-2 text-sm text-[var(--swift-red)]">Default</span>}</h2>
        <p>{[address.addressLine1, address.addressLine2, address.city].filter(Boolean).join(', ')}</p>
        {address.instructions && <p className="text-sm text-[var(--swift-muted)]">{address.instructions}</p>}
        <div className="flex flex-wrap gap-2">
          {!address.isDefault && <button className={secondaryClass} disabled={busy || editing !== null} onClick={() => void change(() => accountApi.defaultAddress(address.id))}>Make {address.label} default</button>}
          <button className={secondaryClass} disabled={busy || editing !== null} onClick={() => { setRemoving(null); setEditing(address); }}>Edit {address.label}</button>
          <button className={secondaryClass} disabled={busy || editing !== null} onClick={() => setRemoving(address)}>Remove {address.label}</button>
        </div>
      </li>)}</ul>}
    {removing && <div role="dialog" aria-label={`Remove ${removing.label}?`} className="space-y-3 rounded-2xl border border-[var(--swift-border-strong)] bg-[var(--swift-card)] p-4">
      <p>Remove {removing.label}? {removing.addressLine1}, {removing.city}</p>
      <div className="flex gap-2"><button className={secondaryClass} disabled={busy} onClick={() => setRemoving(null)}>Keep address</button><button className={buttonClass} disabled={busy} onClick={() => void change(() => accountApi.deleteAddress(removing.id))}>Confirm removal</button></div>
    </div>}
    {error && <p role="alert">{error}</p>}
    {editing ? <AddressForm key={editing === 'new' ? 'new' : editing.id} address={editing === 'new' ? undefined : editing} onCancel={() => setEditing(null)} onSaved={savedAddress} />
      : <button className={buttonClass} disabled={busy || !addresses.data || addresses.isError} onClick={() => { setRemoving(null); setEditing('new'); }}>Add an address</button>}
  </AccountFrame>;
}

function AddressForm({ address, onSaved, onCancel }: { address?: Address; onSaved: (_saved: Address) => Promise<void>; onCancel: () => void }) {
  const [form, setForm] = useState({ label: address?.label ?? 'Home', addressLine1: address?.addressLine1 ?? '', addressLine2: address?.addressLine2 ?? '', city: address?.city ?? 'Georgetown', region: address?.region ?? 'Demerara-Mahaica', instructions: address?.instructions ?? '' });
  const revision = useRef(0);
  const [fieldRevision, setFieldRevision] = useState(0);
  const [place, setPlace] = useState<PickedPlace | null>(() => address ? { label: address.addressLine1, lat: Number(address.latitude), lng: Number(address.longitude), placeId: address.id } : null);
  const [isDefault, setIsDefault] = useState(true);
  const [busy, setBusy] = useState(false);
  const [locating, setLocating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sending = useRef(false);
  const currentAddress = useRef(form);
  currentAddress.current = form;
  function edit(patch: Partial<typeof form>) {
    if ('city' in patch || 'region' in patch) { revision.current += 1; setFieldRevision(revision.current); setPlace(null); }
    setForm((old) => ({ ...old, ...patch })); setError(null);
  }
  function changeStreet(text: string, selected: PickedPlace | null) {
    if (revision.current !== fieldRevision || currentAddress.current.addressLine1 !== form.addressLine1) return;
    setForm((old) => ({ ...old, addressLine1: text })); setPlace(selected);
    if (selected && selected !== place) {
      revision.current += 1; setFieldRevision(revision.current);
    }
  }
  async function locate() {
    const captured = form;
    setLocating(true); setError(null);
    try {
      const fix = await currentFix('put this address on the map');
      if (addressKey(currentAddress.current) !== addressKey(captured) || currentAddress.current.region !== captured.region) return;
      const result = acceptFix({ key: addressKey(captured), ...fix, now: Date.now() });
      if (!result.ok) { setPlace(null); setError(result.message); return; }
      setPlace({ label: captured.addressLine1, lat: result.place.lat, lng: result.place.lng, placeId: 'device' });
    } catch (e) { setError((e as Error).message); }
    finally { setLocating(false); }
  }
  const ready = form.label.trim().length >= 1 && form.addressLine1.trim().length >= 1 && form.addressLine1.length <= 200 && form.city.trim().length >= 1 && place !== null
    && Number.isFinite(place.lat) && Math.abs(place.lat) <= 90 && Number.isFinite(place.lng) && Math.abs(place.lng) <= 180 && !(place.lat === 0 && place.lng === 0);
  async function save(event: FormEvent) {
    event.preventDefault();
    if (!ready || !place || sending.current) return;
    // A suggestion inside the shared location field is not the Save action.
    if ((event.nativeEvent as SubmitEvent).submitter?.getAttribute('data-save-address') !== 'true') return;
    sending.current = true; setBusy(true); setError(null);
    const body: AddressInput = { ...form, label: form.label.trim(), addressLine1: form.addressLine1.trim(), city: form.city.trim(), latitude: place.lat, longitude: place.lng };
    try {
      const saved = address ? await accountApi.updateAddress(address.id, body)
        : await accountApi.addAddress({ ...body, isDefault });
      await onSaved(saved);
    } catch (e) { setError((e as Error).message); }
    finally { sending.current = false; setBusy(false); }
  }
  return <form onSubmit={save} className="space-y-4 sw-card p-5">
    <h2 className="font-bold">{address ? 'Edit address' : 'Add address'}</h2>
    <fieldset disabled={busy} className="space-y-3">
      <label className="block space-y-1"><span>Label</span><input className={fieldClass} required maxLength={50} value={form.label} onChange={(e) => edit({ label: e.target.value })} /></label>
      <LocationField key={fieldRevision} label="Street address" text={form.addressLine1} place={place} onChange={changeStreet} />
      <label className="block space-y-1"><span>Apt / landmark (optional)</span><input className={fieldClass} maxLength={200} value={form.addressLine2} onChange={(e) => edit({ addressLine2: e.target.value })} /></label>
      <label className="block space-y-1"><span>City / town</span><input className={fieldClass} required maxLength={100} value={form.city} onChange={(e) => edit({ city: e.target.value })} /></label>
      <label className="block space-y-1"><span>Region</span><input className={fieldClass} maxLength={100} value={form.region} onChange={(e) => edit({ region: e.target.value })} /></label>
      <label className="block space-y-1"><span>Delivery instructions (optional)</span><input className={fieldClass} maxLength={500} value={form.instructions} onChange={(e) => edit({ instructions: e.target.value })} /></label>
      <button type="button" className={secondaryClass} disabled={locating || !form.addressLine1.trim()} onClick={() => void locate()}>{locating ? 'Getting your location…' : 'I am at this address — set the pin'}</button>
      <p className="text-sm text-[var(--swift-muted)]">{place ? 'Pin saved for this address. Changing the street, city or region needs a new pin.' : 'Choose a search result, or stand at the address and set the pin.'}</p>
      {!address && <label className="flex min-h-11 items-center gap-3"><input type="checkbox" checked={isDefault} onChange={(e) => setIsDefault(e.target.checked)} />Make this my default address</label>}
    </fieldset>
    {error && <p role="alert">{error}</p>}
    <div className="flex gap-2"><button data-save-address="true" className={buttonClass} disabled={busy || !ready}>{busy ? 'Saving…' : 'Save address'}</button><button type="button" className={secondaryClass} disabled={busy} onClick={onCancel}>Cancel</button></div>
  </form>;
}
