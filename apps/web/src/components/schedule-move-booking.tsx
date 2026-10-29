'use client';

import { useEffect, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Modal } from '@/components/modal';
import { apiFetch } from '@/lib/auth';
import { storeKey, useStoreId } from '@/lib/store-scope';
import type { VendorBooking } from '@/lib/booking-api';
import { formatAppointmentClock, formatAppointmentDay, formatAppointmentSlot } from '@/lib/appointmentTime';
import { addAppointmentDays, appointmentDayKey, appointmentWeekday } from '../../../mobile/src/lib/appointmentTime';

type MoveTimes = { slots?: string[]; bookableWeekdays?: number[] };

/** The free times of a listing on one Guyana day: the same answer the customer's picker reads
 *  (GET /customer/items/:id/slots), never re-derived here (the app's useBookingMoveTimes). */
const getMoveTimes = (itemId: string, date: string): Promise<MoveTimes> =>
  apiFetch(`/api/v1/customer/items/${encodeURIComponent(itemId)}/slots?date=${encodeURIComponent(date)}`).then((r) => (r.data ?? {}) as MoveTimes);

/** Move a booking to another free time of the same service (POST /vendor/bookings/:id/reschedule). */
const moveBooking = (bookingId: string, newSlotStart: string) =>
  apiFetch(`/api/v1/vendor/bookings/${encodeURIComponent(bookingId)}/reschedule`, { method: 'POST', body: JSON.stringify({ newSlotStart }) });

/**
 * [BOOK-S5b · owner B2] "Move" on the Schedule: the app's MoveBookingSheet (#2196). Another free time of the SAME
 * service, from the server's own free times (the booking's own time is left out). The server judges the move and
 * tells the customer; a refusal (a time just taken, a finished booking) is shown in its words and the time is let
 * go. A failed read of the times is an error with a retry, never "no times". The page loads this dialog on tap.
 */
export default function MoveBookingDialog({ booking, onClose }: { booking: VendorBooking; onClose: () => void }) {
  const storeId = useStoreId();
  const queryClient = useQueryClient();
  const today = appointmentDayKey(new Date());
  const [dayOffset, setDayOffset] = useState(0);
  const day = addAppointmentDays(today, dayOffset);
  const [slot, setSlot] = useState<string | null>(null);
  const [answer, setAnswer] = useState<MoveTimes | null>(null);
  const [readState, setReadState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [reload, setReload] = useState(0);
  const [moving, setMoving] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setReadState('loading');
    getMoveTimes(booking.itemId ?? '', day).then((next) => {
      if (!alive) return;
      setAnswer(next);
      setReadState('ready');
    }, () => { if (alive) setReadState('error'); });
    return () => { alive = false; };
  }, [booking.itemId, day, reload]);

  const current = new Date(booking.slotStart).getTime();
  const times = useMemo(() => (answer?.slots ?? []).filter((iso) => new Date(iso).getTime() !== current), [answer, current]);
  const bookableWeekdays = answer?.bookableWeekdays;

  const close = () => { if (!moving) onClose(); };
  const confirm = async () => {
    if (!slot || moving) return;
    setMoving(true);
    setRefusal(null);
    try {
      await moveBooking(booking.id, slot);
      onClose();
    } catch (error) {
      setSlot(null);
      setRefusal(error instanceof Error && error.message ? error.message : 'Couldn’t move the booking. Try again.');
    } finally {
      setMoving(false);
      // The schedule (and the order the booking belongs to) is read again whatever the outcome: a timeout can mean it moved.
      void queryClient.invalidateQueries({ queryKey: storeKey(storeId, 'bookings') });
      void queryClient.invalidateQueries({ queryKey: storeKey(storeId, 'orders') });
    }
  };

  return (
    <Modal labelledBy="move-booking-title" onClose={close} className="bg-[var(--swift-card)] px-6 pb-6 pt-5">
      <h2 id="move-booking-title" className="sw-title text-center">Move this booking</h2>
      <p className="sw-caption mt-1 text-center">
        {booking.serviceName} · now {formatAppointmentSlot(booking.slotStart)}. The customer is told the new time.
      </p>
      <div className="mt-4 flex flex-wrap gap-2" role="group" aria-label="Day">
        {Array.from({ length: 7 }, (_, i) => {
          const key = addAppointmentDays(today, i);
          const closed = bookableWeekdays ? !bookableWeekdays.includes(appointmentWeekday(key)) : false;
          const label = i === 0 ? 'Today' : formatAppointmentDay(key);
          return (
            <button key={key} type="button" className="sw-chip" aria-pressed={dayOffset === i} disabled={closed || moving}
              onClick={() => { setDayOffset(i); setSlot(null); }} data-modal-initial-focus={i === 0 ? true : undefined}>
              {closed ? `${label} · closed` : label}
            </button>
          );
        })}
      </div>
      <div className="mt-3">
        {readState === 'loading' ? (
          <p className="text-sm text-[var(--swift-muted)]" role="status">Checking times…</p>
        ) : readState === 'error' ? (
          <div className="flex flex-wrap items-center gap-2" role="alert">
            <p className="text-sm text-[var(--swift-red)]">Couldn’t load the free times. Check your connection and try again.</p>
            <button type="button" className="sw-chip" onClick={() => setReload((n) => n + 1)}>Try again</button>
          </div>
        ) : times.length === 0 ? (
          <p className="text-sm text-[var(--swift-muted)]" role="status">No other free times this day — try another.</p>
        ) : (
          <div className="flex flex-wrap gap-2" role="group" aria-label="Free times">
            {times.map((iso) => (
              <button key={iso} type="button" className="sw-chip" aria-pressed={slot === iso} disabled={moving} onClick={() => setSlot(iso)}>
                {formatAppointmentClock(iso)}
              </button>
            ))}
          </div>
        )}
      </div>
      {refusal ? <p role="alert" className="mt-3 text-center text-sm text-[var(--swift-red)]">{refusal}</p> : null}
      <button type="button" className="sw-btn sw-btn-block mt-5" disabled={!slot || moving} onClick={() => void confirm()}>
        {moving ? 'Moving…' : slot ? `Move to ${formatAppointmentSlot(slot)}` : 'Pick a new time'}
      </button>
      <button type="button" className="sw-btn sw-btn-outline sw-btn-block mt-2" disabled={moving} onClick={close}>Keep this time</button>
    </Modal>
  );
}
