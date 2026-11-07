'use client';

import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getProfile, updateProfile } from '@/lib/vendor-api';
import { storeKey } from '@/lib/store-scope';

/** The most the server takes (booking/one-at-a-time.ts MAX_BOOKING_CAPACITY), as the app's card says. */
export const BOOKING_CAPACITY_MAX = 20;

type ProfileStores = { vendors?: Array<{ id: string; vendorType?: string; bookingCapacity?: unknown }>; myRole?: string };

/** The stored "how many at once", or null when the server sends none (an older server): the app's storedBookingCapacity. */
export function storedBookingCapacity(store: unknown): number | null {
  const v = store && typeof store === 'object' ? (store as { bookingCapacity?: unknown }).bookingCapacity : undefined;
  return typeof v === 'number' && Number.isInteger(v) && v >= 1 ? v : null;
}

/**
 * [BOOK-S5b · owner C1] A Services business's "How many bookings at once", the app's BookingCapacityCard (#2196):
 * one by default (one person, one chair); a business with more chairs or staff takes more at the same time, across
 * all its services. Owners and managers, Services stores only, and only when the server sends the setting. The
 * server judges a lowering against the bookings it already holds, and its refusal is shown in its own words.
 */
export function BookingCapacityCard({ storeId }: { storeId: string | null }) {
  const queryClient = useQueryClient();
  const profile = useQuery({ queryKey: storeKey(storeId, 'profile'), queryFn: getProfile });
  const data = profile.data as ProfileStores | undefined;
  const store = data?.vendors?.find((v) => v.id === storeId) ?? (data?.vendors?.length === 1 ? data.vendors[0] : undefined);
  const manager = data?.myRole === 'OWNER' || data?.myRole === 'MANAGER';
  const value = store?.vendorType === 'SERVICE' ? storedBookingCapacity(store) : null;
  const [count, setCount] = useState(value ?? 1);
  useEffect(() => { if (value != null) setCount(value); }, [value]);

  const save = useMutation({
    mutationFn: (bookingCapacity: number) => updateProfile({ bookingCapacity }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: storeKey(storeId, 'profile') }),
  });

  if (!manager || value == null) return null;
  const dirty = count !== value;
  return (
    <div className="sw-card p-6">
      <h2 className="font-bold" id="booking-capacity-title">How many bookings at once</h2>
      <p className="mt-1 text-sm text-[var(--swift-muted)]">
        {count === 1
          ? 'One booking at a time across all your services. Choose more if several people or chairs serve customers at the same time.'
          : `Up to ${count} bookings at the same time, across all your services.`}
      </p>
      <div className="mt-3 flex items-center gap-3" role="group" aria-labelledby="booking-capacity-title">
        <button type="button" className="sw-chip" disabled={count <= 1 || save.isPending} onClick={() => { save.reset(); setCount((c) => Math.max(1, c - 1)); }}>Fewer</button>
        <span className="min-w-8 text-center text-lg font-bold" aria-live="polite">{count}</span>
        <button type="button" className="sw-chip" disabled={count >= BOOKING_CAPACITY_MAX || save.isPending} onClick={() => { save.reset(); setCount((c) => Math.min(BOOKING_CAPACITY_MAX, c + 1)); }}>More</button>
      </div>
      {save.isError ? (
        <p role="alert" className="mt-2 text-sm text-[var(--swift-red)]">
          {save.error instanceof Error && save.error.message ? save.error.message : 'That could not be saved. Check your connection and try again.'}
        </p>
      ) : null}
      {dirty ? (
        <button type="button" onClick={() => save.mutate(count)} disabled={save.isPending}
          className="mt-3 rounded-lg bg-[var(--swift-red)] px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">
          {save.isPending ? 'Saving…' : 'Save'}
        </button>
      ) : null}
    </div>
  );
}
