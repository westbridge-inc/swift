'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getProfile, updateProfile } from '@/lib/vendor-api';
import { setDraftDirty, storeKey } from '@/lib/store-scope';
import type { StorePin } from '@/lib/store-pin';
import { loadStorePicker } from '@/app/signup/store-picker-loader';
import type { StoreLocationPicker as StoreLocationPickerComponent } from '@/components/store-location-picker';

/** The phone's words for the pin (VendorAccountScreen StoreLocationCard; the test reads them there). */
export const STORE_LOCATION_WORDS = {
  title: 'Store location',
  moved: 'Store pin moved. Riders and customers will come to the new spot.',
  pinFailed: 'The pin could not be saved. Try again.',
  pinStays: 'Changing the address words does not move the pin. Riders and customers are sent to the pin: move it too if the store moved.',
  addressTooShort: 'Enter the street address (3 to 200 characters) and the city or village (2 to 100 characters).',
} as const;
const DRAFT = 'Store address';

type LocationStore = {
  id: string;
  addressLine1?: string | null;
  city?: string | null;
  region?: string | null;
  latitude?: number | null;
  longitude?: number | null;
};
type ProfileStores = { vendors?: LocationStore[]; myRole?: string };

const input = 'mt-1 w-full rounded-lg border border-[var(--swift-border)] px-3 py-2 text-sm font-normal';

/**
 * [WEB-SETTINGS · owner 31 Oct 2026] Where the store is, on the website: the phone's Account > "Store location"
 * (owner only, as the phone and the API: either coordinate makes a write the owner's). The pin riders and customers are
 * sent to is moved with the website's own store-location picker (the sign-up's, loaded only when opened) and saved as
 * PUT /vendor/profile { latitude, longitude }, nothing else, as the phone sends it; the server holds a moved pin to the
 * market rule, records the move and tells the owner, and its refusal is shown in its words. The address WORDS (street,
 * city, region) are set at sign-up and the phone cannot change them; here the owner corrects them on their own, held to
 * the sign-up's minimums, and the pin stays where it is.
 */
export function StoreLocationCard({ storeId }: { storeId: string | null }) {
  const queryClient = useQueryClient();
  const profile = useQuery({ queryKey: storeKey(storeId, 'profile'), queryFn: getProfile });
  const data = profile.data as ProfileStores | undefined;
  const store = data?.vendors?.find((v) => v.id === storeId) ?? (data?.vendors?.length === 1 ? data.vendors[0] : undefined);
  const owner = data?.myRole === 'OWNER';

  const [placing, setPlacing] = useState(false);
  const [Picker, setPicker] = useState<typeof StoreLocationPickerComponent | null>(null);
  const [pickerFailed, setPickerFailed] = useState(false);
  const loading = useRef(false);
  const loadPicker = useCallback(() => {
    if (loading.current) return;
    loading.current = true;
    setPickerFailed(false);
    loadStorePicker().then((m) => setPicker(() => m.StoreLocationPicker)).catch(() => setPickerFailed(true)).finally(() => { loading.current = false; });
  }, []);

  const [editing, setEditing] = useState(false);
  const [addr, setAddr] = useState({ addressLine1: '', city: '', region: '' });
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const changes: Record<string, string> = {};
  if (store && editing) {
    for (const field of ['addressLine1', 'city', 'region'] as const) {
      if (addr[field].trim() !== (store[field] ?? '').trim()) changes[field] = addr[field].trim();
    }
  }
  const dirty = Object.keys(changes).length > 0;
  useEffect(() => {
    setDraftDirty(DRAFT, dirty);
    return () => setDraftDirty(DRAFT, false);
  }, [dirty]);

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: storeKey(storeId, 'profile') });
    void queryClient.invalidateQueries({ queryKey: ['stores'] });
  };
  const movePin = useMutation({
    mutationFn: (pin: StorePin) => updateProfile({ latitude: pin.latitude, longitude: pin.longitude }),
    onMutate: () => { setError(null); setNotice(null); },
    onSuccess: () => { setPlacing(false); setNotice(STORE_LOCATION_WORDS.moved); refresh(); },
    onError: (e) => setError(e instanceof Error && e.message ? e.message : STORE_LOCATION_WORDS.pinFailed),
  });
  const saveAddress = useMutation({
    mutationFn: (body: Record<string, string>) => updateProfile(body),
    onMutate: () => { setError(null); setNotice(null); },
    onSuccess: () => { setEditing(false); setNotice('Address saved ✓'); refresh(); },
    onError: (e) => setError(e instanceof Error && e.message ? e.message : 'The address could not be saved. Try again.'),
  });

  if (!store || !owner) return null;
  const where = [store.addressLine1, store.city, store.region].filter(Boolean).join(', ');
  const current: StorePin | null = Number.isFinite(store.latitude) && Number.isFinite(store.longitude)
    ? { latitude: store.latitude as number, longitude: store.longitude as number, address: null }
    : null;

  const openAddress = () => {
    setAddr({ addressLine1: store.addressLine1 ?? '', city: store.city ?? '', region: store.region ?? '' });
    setError(null);
    setNotice(null);
    setEditing(true);
  };
  const submitAddress = () => {
    if (!dirty || saveAddress.isPending) return;
    const line = addr.addressLine1.trim();
    const city = addr.city.trim();
    if (line.length < 3 || line.length > 200 || city.length < 2 || city.length > 100 || addr.region.trim().length > 100) {
      setError(STORE_LOCATION_WORDS.addressTooShort);
      return;
    }
    saveAddress.mutate(changes);
  };

  return (
    <div className="sw-card p-6">
      <h2 className="font-bold">{STORE_LOCATION_WORDS.title}</h2>
      {where && <p className="mt-1 text-sm">{where}</p>}
      <p className="mt-1 text-sm text-[var(--swift-muted)]">The pin is where riders and customers are sent.</p>

      {placing ? (
        <div className="mt-4">
          {Picker ? (
            <Picker current={current} address={where} onConfirm={(pin) => { if (!movePin.isPending) movePin.mutate(pin); }} onClose={() => { setPlacing(false); setError(null); }} />
          ) : pickerFailed ? (
            <div role="alert" className="space-y-2">
              <p className="text-sm">The map didn&apos;t load. Check your connection and try again.</p>
              <button type="button" className="sw-chip" onClick={loadPicker}>Try again</button>
              <button type="button" className="sw-chip" onClick={() => setPlacing(false)}>Back</button>
            </div>
          ) : (
            <p role="status" className="text-sm">Loading the map…</p>
          )}
          {movePin.isPending && <p role="status" className="mt-2 text-sm">Saving the pin…</p>}
        </div>
      ) : editing ? (
        <div className="mt-4 space-y-3">
          <label className="block text-sm font-semibold">
            Street address
            <input className={input} autoComplete="street-address" maxLength={200} value={addr.addressLine1} onChange={(e) => { setAddr({ ...addr, addressLine1: e.target.value }); setError(null); }} />
          </label>
          <label className="block text-sm font-semibold">
            City or village
            <input className={input} autoComplete="address-level2" maxLength={100} value={addr.city} onChange={(e) => { setAddr({ ...addr, city: e.target.value }); setError(null); }} />
          </label>
          <label className="block text-sm font-semibold">
            Region (optional)
            <input className={input} autoComplete="address-level1" maxLength={100} value={addr.region} onChange={(e) => { setAddr({ ...addr, region: e.target.value }); setError(null); }} />
          </label>
          <p className="text-xs text-[var(--swift-muted)]">{STORE_LOCATION_WORDS.pinStays}</p>
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" onClick={submitAddress} disabled={!dirty || saveAddress.isPending} className="rounded-lg bg-[var(--swift-red)] px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">
              {saveAddress.isPending ? 'Saving…' : 'Save address'}
            </button>
            <button type="button" onClick={() => { setEditing(false); setError(null); }} disabled={saveAddress.isPending} className="px-2 text-sm font-semibold text-[var(--swift-muted)]">Cancel</button>
          </div>
        </div>
      ) : (
        <div className="mt-3 flex flex-wrap gap-2">
          <button type="button" className="sw-chip" onClick={() => { setError(null); setNotice(null); setPlacing(true); if (!Picker) loadPicker(); }}>Move the pin</button>
          <button type="button" className="sw-chip" onClick={openAddress}>Edit the address</button>
        </div>
      )}
      {notice && <p role="status" className="mt-2 text-sm font-medium text-green-600">{notice}</p>}
      {error && <p role="alert" className="mt-2 text-sm text-[var(--swift-red)]">{error}</p>}
    </div>
  );
}
