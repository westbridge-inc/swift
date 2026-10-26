'use client';

import { Suspense, useState } from 'react';
import Link from 'next/link';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Ban, Calendar, X } from 'lucide-react';
import { DataUnavailable } from '@/components/data-unavailable';
import { MutationNotice } from '@/components/mutation-notice';
import { storeKey, useStoreId } from '@/lib/store-scope';
import { useStoreRole } from '@/lib/store-role';
import { lazyRetry } from '@/lib/chunk-retry';
import { getStores, money } from '@/lib/vendor-api';
import {
  deleteBookingException, getBookingExceptions, getBookings, getListingNames,
  type VendorBooking, type VendorBookingException,
} from '@/lib/booking-api';
import { formatAppointmentClock, formatAppointmentDay } from '@/lib/appointmentTime';
// The market-day keys from the app's own file, as the business board already
// does (lib/vendor-hub guyanaDayKey), so the console loads one copy of them.
import { addAppointmentDays, appointmentDayKey } from '../../../../../mobile/src/lib/appointmentTime';

// [size budget] Opened by a tap: loaded then, not in the tab's first load.
const BlockTimeDialog = lazyRetry(() => import('@/components/schedule-block-time'));

/** The selected store's type, from the same stores read the console shell makes
 *  (`known` once it answered; `failed` when it failed with no answer at all). */
function useSelectedStoreType(): { vendorType: string | undefined; known: boolean; failed: boolean } {
  const storeId = useStoreId();
  const stores = useQuery({ queryKey: ['stores'], queryFn: getStores });
  const list = stores.data?.stores ?? [];
  const store = list.find((s) => s.id === storeId) ?? list.find((s) => s.id === stores.data?.selectedId);
  return { vendorType: store?.vendorType, known: stores.isSuccess, failed: stores.isError && stores.data === undefined };
}

/** [UI-SWEEP, REVIEW-F #2013 S4-1] The app's words for a booking
 *  (VendorScheduleScreen bookingStatusPill). This is BookingStatus (RESERVED,
 *  CONFIRMED, COMPLETED, CANCELLED), its own vocabulary, not an order's.
 *  GET /vendor/bookings drops only CANCELLED, so a COMPLETED appointment is
 *  served, and it used to read 'Reserved'. A status this build was not taught
 *  says so, never a guess. */
function bookingWords(status: string): string {
  switch (status) {
    case 'RESERVED': return 'Reserved';
    case 'CONFIRMED': return 'Confirmed';
    case 'COMPLETED': return 'Completed';
    case 'CANCELLED': return 'Cancelled';
    default: return 'Status unavailable';
  }
}

const blockWhen = (e: VendorBookingException) => (e.start && e.end ? `${e.start}–${e.end}` : 'all day');

/** [UI-SWEEP, REVIEW-F #2013 S4-2] A block with an itemId closes ONE listing;
 *  it used to read 'Blocked · all day', as if the whole store were closed. The
 *  app's words: '<listing> blocked · …', 'One listing blocked · …' when the
 *  name is not known. */
const blockTitle = (e: VendorBookingException, names: Map<string, string> | undefined) => {
  if (!e.itemId) return `Blocked · ${blockWhen(e)}`;
  return `${names?.get(e.itemId) ?? 'One listing'} blocked · ${blockWhen(e)}`;
};
const blockSpoken = (e: VendorBookingException, names: Map<string, string> | undefined) => {
  if (!e.itemId) return blockWhen(e);
  return `${names?.get(e.itemId) ?? 'one listing'}, ${blockWhen(e)}`;
};

function AppointmentRow({ b }: { b: VendorBooking }) {
  const confirmed = b.status === 'CONFIRMED';
  return (
    <li className="sw-card flex items-center gap-4 p-4">
      <div className="min-w-[64px] text-center">
        <p className="text-sm font-bold">{formatAppointmentClock(b.slotStart)}</p>
        <p className="text-xs text-[var(--swift-muted)]">{formatAppointmentClock(b.slotEnd)}</p>
      </div>
      <span aria-hidden className="w-px self-stretch bg-[var(--swift-border)]" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-semibold">{b.serviceName}</p>
        <p className="truncate text-xs text-[var(--swift-muted)]">
          {b.customer?.firstName ?? 'Customer'}{b.price ? ` · ${money(b.price)}` : ''}
        </p>
      </div>
      <span className={`flex-none rounded-full px-3 py-1 text-[12px] font-semibold ${confirmed ? 'bg-[var(--swift-soft-success)] text-[var(--swift-success)]' : 'bg-[var(--swift-sunken)] text-[var(--swift-muted)]'}`}>
        {bookingWords(b.status)}
      </span>
    </li>
  );
}

/**
 * The app's Schedule tab for a Services store (apps/mobile VendorScheduleScreen,
 * scheduling spec 2.2): a 7-day strip, then the chosen day's blocked time (one
 * click to unblock) and its appointments, plus "Block time" (all day or a
 * window). Owners and managers only, as in the app. Fed by GET /vendor/bookings
 * and /vendor/bookings/exceptions; the store's live feed re-reads the bookings
 * the moment one is made, moved or cancelled, and the minute poll stays the floor.
 */
export default function SchedulePage() {
  const storeId = useStoreId();
  const queryClient = useQueryClient();
  const { manager, known: roleKnown, failed: roleFailed } = useStoreRole();
  const { vendorType, known: typeKnown, failed: typeFailed } = useSelectedStoreType();
  const service = vendorType === 'SERVICE';
  const enabled = manager && service;
  const bookings = useQuery({ queryKey: storeKey(storeId, 'bookings'), queryFn: getBookings, enabled, refetchInterval: 60_000 });
  const blocks = useQuery({ queryKey: storeKey(storeId, 'booking-exceptions'), queryFn: getBookingExceptions, enabled, staleTime: 30_000 });
  // A label only: while it is out or if it fails, a one-listing block says 'One listing'.
  const listingNames = useQuery({ queryKey: storeKey(storeId, 'listing-names'), queryFn: getListingNames, enabled, staleTime: 60_000 });
  // [size budget] A plain call with the same states, not useMutation: react-query's
  // mutation code then stays out of this tab's first load (the Block time dialog,
  // loaded on tap, brings its own).
  const [removing, setRemoving] = useState(false);
  const [removeError, setRemoveError] = useState<unknown>(null);
  const removeBlock = (id: string) => {
    setRemoving(true);
    setRemoveError(null);
    deleteBookingException(id).then(() => {
      void queryClient.invalidateQueries({ queryKey: storeKey(storeId, 'booking-exceptions') });
      void queryClient.invalidateQueries({ queryKey: storeKey(storeId, 'bookings') });
    }, setRemoveError).finally(() => setRemoving(false));
  };
  const [dayKey, setDayKey] = useState(() => appointmentDayKey(new Date()));
  const [blocking, setBlocking] = useState(false);

  // The strip follows the market calendar, including near UTC midnight.
  const today = appointmentDayKey(new Date());
  const strip = Array.from({ length: 7 }, (_, i) => {
    const key = addAppointmentDays(today, i);
    return { key, label: i === 0 ? 'Today' : formatAppointmentDay(key) };
  });

  const header = (
    <div className="flex flex-wrap items-end justify-between gap-3">
      <h1 className="sw-title">Schedule</h1>
      {enabled && <button type="button" className="sw-btn sw-btn-md" onClick={() => setBlocking(true)}>Block time</button>}
    </div>
  );
  // Failure first: a store read that failed never reads as "loading" for ever.
  if (roleFailed || typeFailed) {
    const retry = () => {
      void queryClient.invalidateQueries({ queryKey: storeKey(storeId, 'my-role') });
      void queryClient.invalidateQueries({ queryKey: ['stores'] });
    };
    return <div className="space-y-6">{header}<DataUnavailable what="your store" onRetry={retry} /></div>;
  }
  if (roleKnown && !manager) {
    return <div className="space-y-6">{header}<p className="sw-card p-6 text-sm text-[var(--swift-muted)]">The schedule is for the store&apos;s owner and managers.</p></div>;
  }
  if (typeKnown && !service) {
    return (
      <div className="space-y-6">{header}
        <p className="sw-card p-6 text-sm text-[var(--swift-muted)]">
          The schedule is for Services stores. Your opening hours are in <Link href="/dashboard/settings" className="font-semibold underline">Account</Link>.
        </p>
      </div>
    );
  }

  const dayBookings = (bookings.data ?? []).filter((b) => appointmentDayKey(b.slotStart) === dayKey);
  const dayBlocks = (blocks.data ?? []).filter((e) => e.date.slice(0, 10) === dayKey);
  const loading = !enabled || bookings.isLoading || blocks.isLoading;
  return (
    <div className="space-y-6">
      {header}
      <div className="sw-chip-row" role="group" aria-label="Day">
        {strip.map((d) => (
          <button key={d.key} type="button" className="sw-chip" aria-pressed={d.key === dayKey} onClick={() => setDayKey(d.key)}>{d.label}</button>
        ))}
      </div>
      {/* Failure first: a failed read never reads as an empty day. */}
      {bookings.isError ? (
        <DataUnavailable what="your schedule" error={bookings.error} onRetry={() => void bookings.refetch()} />
      ) : blocks.isError ? (
        <DataUnavailable what="your blocked time" error={blocks.error} onRetry={() => void blocks.refetch()} />
      ) : loading ? (
        <div className="sw-empty" role="status"><span className="sw-skeleton h-24 w-full" />Loading your schedule…</div>
      ) : (
        <div className="space-y-3">
          <MutationNotice errors={[removeError]} />
          {dayBlocks.length > 0 && (
            <ul className="space-y-3" aria-label="Blocked time">
              {dayBlocks.map((e) => (
                <li key={e.id} className="flex items-center gap-4 rounded-2xl border border-[var(--swift-border)] bg-[var(--swift-sunken)] p-4">
                  <Ban size={16} aria-hidden className="text-[var(--swift-muted)]" />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-semibold">{blockTitle(e, listingNames.data)}</p>
                    {e.reason && <p className="truncate text-xs text-[var(--swift-muted)]">{e.reason}</p>}
                  </div>
                  <button type="button" className="sw-icon-btn" aria-label={`Remove block, ${blockSpoken(e, listingNames.data)}`} disabled={removing}
                    onClick={() => removeBlock(e.id)}>
                    <X size={18} aria-hidden />
                  </button>
                </li>
              ))}
            </ul>
          )}
          {dayBookings.length === 0 && dayBlocks.length === 0 ? (
            <div className="sw-card flex flex-col items-center p-8 text-center">
              <Calendar size={28} aria-hidden className="text-[var(--swift-muted)]" />
              <p className="mt-3 text-sm font-semibold">No bookings this day</p>
              <p className="mt-1 text-sm text-[var(--swift-muted)]">Your open hours are visible to customers — reservations land here.</p>
            </div>
          ) : dayBookings.length > 0 && (
            <ul className="space-y-3" aria-label="Appointments">
              {dayBookings.map((b) => <AppointmentRow key={b.id} b={b} />)}
            </ul>
          )}
        </div>
      )}
      {blocking && <Suspense fallback={null}><BlockTimeDialog dayKey={dayKey} onClose={() => setBlocking(false)} /></Suspense>}
    </div>
  );
}
