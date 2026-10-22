'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Ban, CalendarDays, X } from 'lucide-react';
import { Modal } from '@/components/modal';
import { DataUnavailable } from '@/components/data-unavailable';
import { MutationNotice } from '@/components/mutation-notice';
import { storeKey, useStoreId } from '@/lib/store-scope';
import { useStoreRole } from '@/lib/store-role';
import { useSelectedVendorType } from '@/lib/catalogue-name';
import {
  createBookingException, deleteBookingException, getBookingExceptions, getBookings, money,
  type VendorBooking, type VendorBookingException,
} from '@/lib/vendor-api';
import { addAppointmentDays, appointmentDayKey, formatAppointmentClock, formatAppointmentDay } from '@/lib/appointmentTime';

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

/** The app's two words for a booking on the day (VendorScheduleScreen AppointmentCard). */
const bookingWords = (status: string) => (status === 'CONFIRMED' ? 'Confirmed' : 'Reserved');

const blockWhen = (e: VendorBookingException) => (e.start && e.end ? `${e.start}–${e.end}` : 'all day');

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
      <span className={`whitespace-nowrap rounded-full px-3 py-1 text-[12px] font-semibold ${confirmed ? 'bg-[var(--swift-soft-success)] text-[var(--swift-success)]' : 'bg-[var(--swift-sunken)] text-[var(--swift-muted)]'}`}>
        {bookingWords(b.status)}
      </span>
    </li>
  );
}

function BlockTimeDialog({ dayKey, onClose }: { dayKey: string; onClose: () => void }) {
  const storeId = useStoreId();
  const queryClient = useQueryClient();
  const [fullDay, setFullDay] = useState(true);
  const [blockStart, setBlockStart] = useState('13:00');
  const [blockEnd, setBlockEnd] = useState('17:00');
  const [note, setNote] = useState('');
  const blockValid = fullDay || (HHMM.test(blockStart) && HHMM.test(blockEnd) && blockStart < blockEnd);
  const addBlock = useMutation({
    mutationFn: () => createBookingException({
      date: dayKey,
      ...(fullDay ? {} : { start: blockStart, end: blockEnd }),
      ...(note.trim() ? { reason: note.trim() } : {}),
    }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: storeKey(storeId, 'booking-exceptions') });
      void queryClient.invalidateQueries({ queryKey: storeKey(storeId, 'bookings') });
      onClose();
    },
  });
  return (
    <Modal labelledBy="block-time-title" onClose={onClose} className="bg-[var(--swift-card)] px-6 pb-6 pt-5">
      <h2 id="block-time-title" className="sw-title text-center">Block time</h2>
      <p className="sw-caption mt-1 text-center">{formatAppointmentDay(dayKey)}. Customers won&apos;t see these slots. Nothing is shown as a reason.</p>
      <div className="mt-5 flex items-center justify-between">
        <span id="block-all-day" className="text-sm">All day</span>
        <button type="button" role="switch" aria-labelledby="block-all-day" aria-checked={fullDay} onClick={() => setFullDay((v) => !v)}
          className="grid h-11 w-16 flex-none place-items-center" data-modal-initial-focus>
          <span className={`sw-stock-switch ${fullDay ? 'bg-[var(--swift-red)]' : 'bg-[var(--swift-border-strong)]'}`}><span className={`sw-stock-knob ${fullDay ? 'translate-x-5' : ''}`} /></span>
        </button>
      </div>
      {!fullDay && (
        <div className="mt-3 grid grid-cols-2 gap-3">
          <label className="block">
            <span className="sw-field-label">From</span>
            <input type="time" className="sw-input" value={blockStart} onChange={(e) => setBlockStart(e.target.value)} />
          </label>
          <label className="block">
            <span className="sw-field-label">Until</span>
            <input type="time" className="sw-input" value={blockEnd} onChange={(e) => setBlockEnd(e.target.value)} />
          </label>
        </div>
      )}
      <label className="mt-3 block">
        <span className="sw-field-label">Note (only you see this)</span>
        <input className="sw-input" value={note} maxLength={200} placeholder="Optional" onChange={(e) => setNote(e.target.value)} />
      </label>
      <MutationNotice errors={[addBlock.error]} className="mt-3" />
      {/* [#947's grammar] Disabled says the ask. */}
      <button type="button" className="sw-btn sw-btn-block mt-5" disabled={!blockValid || addBlock.isPending} onClick={() => addBlock.mutate()}>
        {addBlock.isPending ? 'Blocking…' : blockValid ? 'Block time' : 'Times must be HH:MM, start before end'}
      </button>
      <button type="button" className="sw-btn sw-btn-outline sw-btn-block mt-2" onClick={onClose}>Cancel</button>
    </Modal>
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
  const { vendorType, known: typeKnown, failed: typeFailed } = useSelectedVendorType();
  const service = vendorType === 'SERVICE';
  const enabled = manager && service;
  const bookings = useQuery({ queryKey: storeKey(storeId, 'bookings'), queryFn: getBookings, enabled, refetchInterval: 60_000 });
  const blocks = useQuery({ queryKey: storeKey(storeId, 'booking-exceptions'), queryFn: getBookingExceptions, enabled, staleTime: 30_000 });
  const removeBlock = useMutation({
    mutationFn: (id: string) => deleteBookingException(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: storeKey(storeId, 'booking-exceptions') });
      void queryClient.invalidateQueries({ queryKey: storeKey(storeId, 'bookings') });
    },
  });
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
          <MutationNotice errors={[removeBlock.error]} />
          {dayBlocks.length > 0 && (
            <ul className="space-y-3" aria-label="Blocked time">
              {dayBlocks.map((e) => (
                <li key={e.id} className="flex items-center gap-4 rounded-2xl border border-[var(--swift-border)] bg-[var(--swift-sunken)] p-4">
                  <Ban size={16} aria-hidden className="text-[var(--swift-muted)]" />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-semibold">Blocked · {blockWhen(e)}</p>
                    {e.reason && <p className="truncate text-xs text-[var(--swift-muted)]">{e.reason}</p>}
                  </div>
                  <button type="button" className="sw-icon-btn" aria-label={`Remove block, ${blockWhen(e)}`} disabled={removeBlock.isPending}
                    onClick={() => removeBlock.mutate(e.id)}>
                    <X size={18} aria-hidden />
                  </button>
                </li>
              ))}
            </ul>
          )}
          {dayBookings.length === 0 && dayBlocks.length === 0 ? (
            <div className="sw-card flex flex-col items-center p-8 text-center">
              <CalendarDays size={28} aria-hidden className="text-[var(--swift-muted)]" />
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
      {blocking && <BlockTimeDialog dayKey={dayKey} onClose={() => setBlocking(false)} />}
    </div>
  );
}
