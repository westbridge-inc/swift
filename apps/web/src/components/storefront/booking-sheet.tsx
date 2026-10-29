'use client';

import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { formatAmount } from '@/lib/money';
import { addToCart, clearCart, type CartLine, type MenuItem } from '@/lib/customer';
import { formatAppointmentClock } from '@/lib/appointmentTime';
import { saveHeldTime, type HeldTime } from '@/lib/held-time';
import { queueStorefrontContinuation } from '@/lib/storefront-continuation';
import { Sheet } from '@/components/sheet';
import { BookingChoice } from '@/components/booking/booking-choice';
import styles from './storefront.module.css';

const gyMoney = (value: unknown) => formatAmount(value, '$');

/**
 * [BOOK-S6b] A bookable listing's sheet on the store page: where it happens
 * and a free time, then "Book". Nothing is reserved here: the listing goes in
 * the cart and checkout books the time. The store page loads this file on a
 * tap on Book (its first load does not carry it: scripts/perf-budget).
 *
 * One booking per order (checkout refuses a booking mixed with anything
 * else): the listing goes in the cart on its own, once, and the picked time is
 * held for this tab until checkout sends it. A cart with other lines is
 * emptied only when the customer says so.
 */
export function BookingSheet({
  item, vendorId, vendorName, vendorAddress, price, cartLines, blocked, guest, onBooked, onClose,
}: {
  item: MenuItem;
  vendorId: string;
  vendorName: string;
  vendorAddress: string | null;
  price: number | null;
  /** The newest cart this page has. */
  cartLines: () => CartLine[];
  /** Why the cart cannot be written now (an unresolved checkout, taps still out), or null. */
  blocked: () => string | null;
  /** A guest: the free times are read signed in, so they sign in first and the sheet reopens on return (the queued
   *  intent); nothing is read or added before that. `signIn` also closes this sheet (the intent stays queued). */
  guest: { storeSlug: string; returnPath: string; signIn: () => void } | null;
  /** The booking is in the cart and its time held: the page goes to checkout. */
  onBooked: () => void;
  onClose: () => void;
}) {
  const [picked, setPicked] = useState<HeldTime | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!guest) return;
    queueStorefrontContinuation({ storeSlug: guest.storeSlug, itemId: item.id, selectedOptions: {}, returnPath: guest.returnPath });
    guest.signIn();
    // Once, for the guest who tapped Book.
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const book = async (held: HeldTime) => {
    if (busy) return;
    const stop = blocked();
    if (stop) { setError(stop); return; }
    const lines = cartLines();
    const onlyThisBooking = lines.length === 1 && lines[0]!.itemId === item.id && lines[0]!.quantity === 1;
    if (!onlyThisBooking && lines.length > 0
      && !window.confirm('A booking is placed on its own. Empty your cart and book this instead?')) return;
    setBusy(true);
    setError(null);
    try {
      if (!onlyThisBooking) {
        if (lines.length > 0) await clearCart();
        await addToCart({ vendorId, itemId: item.id, quantity: 1 });
      }
      saveHeldTime(held);
      onBooked();
    } catch (bookError) {
      setError(bookError instanceof Error ? bookError.message : 'Couldn’t add this booking. Try again.');
    } finally {
      setBusy(false);
    }
  };

  if (guest) return null;
  return (
    <Sheet labelledBy="booking-sheet-title" onClose={() => { if (!busy) onClose(); }} className={styles.sheet}>
      <div className={styles.sheetHeader}>
        <div className={styles.sheetHeading}>
          <h2 id="booking-sheet-title" className={styles.modalTitle}>{item.name}</h2>
          {item.description ? <p className={styles.itemDescription}>{item.description}</p> : null}
        </div>
        <button data-modal-initial-focus type="button" className={styles.closeButton} onClick={() => { if (!busy) onClose(); }} aria-label="Close booking">
          <X size={20} aria-hidden="true" />
        </button>
      </div>

      <div className={styles.options}>
        <BookingChoice itemId={item.id} vendorName={vendorName} vendorAddress={vendorAddress} disabled={busy} onChange={setPicked} />
      </div>

      <div className={styles.sheetFooter}>
        {error ? <p className={styles.modalAlert} role="alert">{error}</p> : null}
        <button
          type="button"
          className={`${styles.primaryButton} ${styles.sheetAdd}`}
          disabled={!picked || busy}
          onClick={() => { if (picked) void book(picked); }}
        >
          {busy ? 'Adding…' : picked ? `Book ${formatAppointmentClock(picked.slotStart)} · ${gyMoney(price)}` : 'Pick a time'}
        </button>
      </div>
    </Sheet>
  );
}
