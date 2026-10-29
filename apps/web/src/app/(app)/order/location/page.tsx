'use client';

import { useEffect, useState } from 'react';
import { MapPin, Plus } from 'lucide-react';
import { getAddresses } from '@/lib/customer';
import { DataUnavailable } from '@/components/data-unavailable';
import { AddressForm } from '@/components/account/address-form';

// [W-08] A saved address is a CLAIM that the words and the coordinates describe
// the same place. This page used to pair whatever text was in the form with
// wherever the phone happened to be when Save was pressed: add your home
// address from the office and the order went to the office.
//
// [PINS · row 107] The point is now the pin the person places on Swift's map,
// in the same "add an address" form as the account's Saved addresses (and the
// pin picker the checkout and Send a parcel use): the stored point is the pin
// they saw, never a device fix taken wherever they happen to be.

export default function LocationPage() {
  const [addresses, setAddresses] = useState<Record<string, unknown>[] | null>(null);
  const [listError, setListError] = useState<unknown>(null);
  const [adding, setAdding] = useState(false);

  async function refresh() {
    try {
      setAddresses(await getAddresses());
      setListError(null);
    } catch (e) {
      // [W-08] `.catch(() => [])` rendered a failed read as "you have no
      // addresses" — and then `isDefault: addresses.length === 0` made the next
      // address DEFAULT because the list looked empty. An outage silently
      // repointed the customer's deliveries.
      setAddresses(null);
      setListError(e);
    }
  }
  useEffect(() => { void refresh(); }, []);

  async function saved() {
    setAdding(false);
    await refresh();
  }

  const rows = addresses ?? [];

  return (
    <div className="mx-auto max-w-lg space-y-4">
      <h1 className="sw-title">Delivery addresses</h1>

      {listError !== null && (
        <DataUnavailable what="your saved addresses" error={listError} onRetry={() => void refresh()} />
      )}

      {rows.map((a) => (
        <div key={String(a['id'])} className="flex items-center gap-3 sw-card p-4">
          <MapPin className="h-5 w-5 text-[var(--swift-red)]" />
          <div>
            <p className="font-bold">
              {String(a['label'] ?? '')}{' '}
              {Boolean(a['isDefault']) && (
                <span className="ml-1 rounded-full bg-[var(--swift-red-50)] px-2 py-0.5 text-xs font-bold text-[var(--swift-red)]">Default</span>
              )}
            </p>
            <p className="text-sm text-[var(--swift-muted)]">{String(a['addressLine1'] ?? '')}, {String(a['city'] ?? '')}</p>
          </div>
        </div>
      ))}

      {adding ? (
        <AddressForm
          onSaved={saved}
          onCancel={() => setAdding(false)}
          // Only claim "this is your first address" when the list actually loaded.
          fixedDefault={addresses !== null && addresses.length === 0}
        />
      ) : (
        <button onClick={() => setAdding(true)} className="sw-btn sw-btn-block sw-btn-outline">
          <Plus className="h-4 w-4" /> Add an address
        </button>
      )}
    </div>
  );
}
