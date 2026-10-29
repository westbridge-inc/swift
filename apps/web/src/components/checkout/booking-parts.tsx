'use client';

import Link from 'next/link';
import { Pictogram } from '@/components/glyphs';
import { BookingChoice } from '@/components/booking/booking-choice';
import { formatAppointmentSlot } from '@/lib/appointmentTime';
import {
  bookingSummaryNote,
  checkoutButtonLabel,
  mmgBookingWaitsNote,
  paymentActionForCheckout,
  placedBookingOutcome,
  placedOrderConfirmationCopy,
  placedPopupTitle,
} from '@/lib/booking-rules';
import type { HeldTime } from '@/lib/held-time';
import styles from '@/app/(app)/cart/cart.module.css';

// ---------------------------------------------------------------------------
// [BOOK-S6b] The checkout's booking-only parts. Only a cart of one booking
// draws them, so the checkout loads this file on demand and a delivery or
// pickup order's first load does not carry it (scripts/perf-budget).
// ---------------------------------------------------------------------------

/** "Your booking": the time held (with Change time), or where and when to pick one. */
export function BookingTimePanel({
  itemId, vendorName, vendorAddress, heldTime, changingTime, homeVisit, busy, onChange, onChangingTime,
}: {
  itemId: string;
  vendorName: string;
  vendorAddress: string | null;
  heldTime: HeldTime | null;
  changingTime: boolean;
  homeVisit: boolean;
  busy: boolean;
  onChange: (_held: HeldTime | null) => void;
  onChangingTime: (_changing: boolean) => void;
}) {
  if (heldTime && !changingTime) {
    return (
      <div className={styles.panelStack}>
        <p className={styles.stateCopy}><b>{formatAppointmentSlot(heldTime.slotStart)}</b>{homeVisit ? ' · at your address' : ''}</p>
        <button type="button" disabled={busy} onClick={() => onChangingTime(true)} className={`${styles.button} ${styles.buttonSecondary}`}>Change time</button>
      </div>
    );
  }
  return (
    <div className={styles.panelStack}>
      <BookingChoice itemId={itemId} vendorName={vendorName} vendorAddress={vendorAddress} initial={heldTime} disabled={busy} onChange={onChange} />
      {heldTime ? (
        <button type="button" disabled={busy} onClick={() => onChangingTime(false)} className={`${styles.button} ${styles.buttonSecondary}`}>Keep {formatAppointmentSlot(heldTime.slotStart)}</button>
      ) : null}
    </div>
  );
}

/** The summary's time row. */
export function BookingTimeRow({ heldTime }: { heldTime: HeldTime | null }) {
  return (
    <div className={styles.moneyLine}><span className={styles.moneyLabel}>Time</span><strong className={styles.moneyValue}>{heldTime ? formatAppointmentSlot(heldTime.slotStart) : 'Pick a time'}</strong></div>
  );
}

/** What happens when the customer books (the phone's cart lines, #2194). */
export function BookingNotes({ instant, payingCash, place }: { instant: boolean; payingCash: boolean; place: 'summary' | 'button' }) {
  if (place === 'summary') return <p className={styles.payNote}>{bookingSummaryNote({ everyBookingInstant: instant, payingCash })}</p>;
  const wait = mmgBookingWaitsNote({ appointmentOnly: true, everyBookingInstant: instant, payingCash });
  return wait ? <p className={styles.payNote}>{wait}</p> : null;
}

export interface PlacedBooking {
  orderId: string | null;
  answer: unknown;
  submittedMethod: 'CASH' | 'MOBILE_MONEY';
  mmgPayTo?: 'STORE_NUMBER';
}

/** [like #2194] The placed booking, in the words of the checkout ANSWER: "confirmed" only when its
 *  appointment order came back ACCEPTED (the business's standing acceptance), else requested. */
export function BookingPlaced({ placed }: { placed: PlacedBooking }) {
  const outcome = placedBookingOutcome(placed.answer);
  const title = placedPopupTitle({ appointment: true, outcome });
  const copy = placedOrderConfirmationCopy({
    appointment: true,
    appointmentConfirmed: outcome === 'confirmed',
    pickup: false,
    held: false,
    submittedMethod: placed.submittedMethod,
    paymentAction: paymentActionForCheckout((placed.answer ?? {}) as Parameters<typeof paymentActionForCheckout>[0], placed.submittedMethod),
    ...(placed.mmgPayTo ? { mmgPayTo: placed.mmgPayTo } : {}),
  });
  return (
    <section className={styles.stateCard} role="status" aria-labelledby="booking-placed-title">
      <span className="sw-empty-tile"><Pictogram name="services" size={40} /></span>
      <h1 id="booking-placed-title" className={styles.stateTitle}>{title}</h1>
      <p className={styles.stateCopy}>{copy}</p>
      <Link href={placed.orderId ? `/orders/${placed.orderId}` : '/orders'} className={`${styles.button} ${styles.buttonPrimary} ${styles.retryButton}`}>View booking</Link>
    </section>
  );
}

/** The Book button's words: what is missing first (a time, an address, the server's check of it), then "Book now"
 *  only for an instant listing paid in cash, else "Request booking" (#2194). */
export function BookingButtonLabel({ heldTime, homeVisit, hasAddress, addressChecked, payingCash, total }: {
  heldTime: HeldTime | null; homeVisit: boolean; hasAddress: boolean; addressChecked: boolean; payingCash: boolean; total: string;
}) {
  if (!heldTime) return <>Pick a time to book</>;
  if (homeVisit && !hasAddress) return <>Add your address to book</>;
  // The server checks the address first (as a delivery quote is asked for): nothing is booked yet.
  if (homeVisit && !addressChecked) return <>Check this address</>;
  return <>{`${checkoutButtonLabel({ appointmentOnly: true, pickup: false, everyBookingInstant: heldTime.instant === true, payingCash })} · ${total}`}</>;
}

/** [BOOK-S6b] One booking per order, as checkout places it (one listing, one time): the server refuses a group of
 *  several, and a booking with goods. The words for a cart that breaks it, or null. */
export function bookingCartProblem(items: Array<{ fulfillment?: string; quantity: number }>): string | null {
  if (!items.every((line) => line.fulfillment === 'APPOINTMENT')) {
    return 'A booking is placed on its own. Remove the booking to order the other items, or remove them to book it.';
  }
  if (items.length !== 1) return 'Book one appointment at a time on the web. Remove the other bookings to continue.';
  if (items[0]!.quantity !== 1) return 'A booking is for one appointment. Remove it and book it again from the store page.';
  return null;
}

/** The line after the server checked a home visit's address (nothing is booked yet). */
export function addressCheckedWords(total: string): string {
  return `Swift checked this address: the booking comes to ${total}. Review it, then book.`;
}

/** [perf budget] One on-demand entry for the checkout: each booking part by name. */
export function BookingPart(props:
  | ({ part: 'time-panel' } & Parameters<typeof BookingTimePanel>[0])
  | ({ part: 'time-row' } & Parameters<typeof BookingTimeRow>[0])
  | ({ part: 'notes' } & Parameters<typeof BookingNotes>[0])
  | ({ part: 'label' } & Parameters<typeof BookingButtonLabel>[0])
  | ({ part: 'placed' } & Parameters<typeof BookingPlaced>[0])) {
  switch (props.part) {
    case 'time-panel': return <BookingTimePanel {...props} />;
    case 'time-row': return <BookingTimeRow {...props} />;
    case 'notes': return <BookingNotes {...props} />;
    case 'label': return <BookingButtonLabel {...props} />;
    default: return <BookingPlaced {...props} />;
  }
}
