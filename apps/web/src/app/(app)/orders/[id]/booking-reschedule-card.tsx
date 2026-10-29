'use client';

import { useState } from 'react';
import { formatAppointmentSlot } from '@/lib/appointmentTime';
import { rescheduleBooking } from '@/lib/customer-orders';
import type { AppointmentBookingView } from '@/lib/booking-rules';
import { SlotPicker } from '@/components/booking/slot-picker';
import booking from '@/components/booking/booking.module.css';
import styles from './tracking.module.css';

/** The words for a refused move: the server's message, else a plain retry line (the phone's rescheduleErrorMessage). */
export function rescheduleRefusal(error: unknown): string {
  return error instanceof Error && error.message.trim() ? error.message : 'Couldn’t change the time. Check your connection and try again.';
}

/**
 * [BOOK-S6b · owner B2] "Change time" on the customer's booking: the phone's
 * BookingRescheduleCard. Renders only what the server projected
 * (`appointmentBooking`, sent with INSTANT_BOOKING on): the control appears when
 * the server says a move is allowed now, the times are the server's own free
 * times of the SAME service, and a refusal (a taken time, the two-hour cut-off)
 * is shown in the server's words. When the server says no, its reason is shown
 * instead; when it sends nothing, nothing is shown.
 */
export function BookingRescheduleCard({ view, onMoved }: { view: AppointmentBookingView; onMoved: () => void }) {
  const [open, setOpen] = useState(false);
  const [slot, setSlot] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [moving, setMoving] = useState(false);

  if (!view.canReschedule) {
    return view.rescheduleUnavailable ? (
      <div className={styles.cancelConfirm} role="note"><p>{view.rescheduleUnavailable}</p></div>
    ) : null;
  }

  if (!open) {
    return (
      <button type="button" className={styles.secondaryButton} onClick={() => { setRefusal(null); setOpen(true); }}>
        Change time
      </button>
    );
  }

  const confirmMove = async () => {
    if (!slot || moving) return;
    setRefusal(null);
    setMoving(true);
    try {
      await rescheduleBooking(view.bookingId, slot);
      setOpen(false);
      setSlot(null);
      onMoved();
    } catch (error) {
      setSlot(null);
      setRefusal(rescheduleRefusal(error));
    } finally {
      setMoving(false);
    }
  };

  return (
    <section className={booking.panel} aria-labelledby="change-time-title">
      <h3 id="change-time-title" className={booking.panelTitle}>Change time</h3>
      <p className={booking.note}>Pick another free time for the same service. Your current time stays booked until the move goes through.</p>
      <SlotPicker itemId={view.itemId} value={slot} onChange={setSlot} exclude={view.slotStart} disabled={moving} label="New time" />
      {refusal ? <p className={styles.alert} role="alert">{refusal}</p> : null}
      <div className={styles.confirmActions}>
        <button type="button" className={styles.primaryButton} disabled={!slot || moving} onClick={() => void confirmMove()}>
          {moving ? 'Moving…' : slot ? `Move to ${formatAppointmentSlot(slot)}` : 'Pick a new time'}
        </button>
        <button type="button" className={styles.secondaryButton} disabled={moving} onClick={() => { setOpen(false); setSlot(null); setRefusal(null); }}>
          Keep my time
        </button>
      </div>
    </section>
  );
}
