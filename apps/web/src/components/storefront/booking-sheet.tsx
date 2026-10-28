'use client';

import { useState } from 'react';
import { X } from 'lucide-react';
import { formatAmount } from '@/lib/money';
import type { MenuItem } from '@/lib/customer';
import { formatAppointmentClock } from '@/lib/appointmentTime';
import type { PendingAppointment } from '@/lib/pending-appointments';
import { Sheet } from '@/components/sheet';
import { BookingChoice } from '@/components/booking/booking-choice';
import styles from './storefront.module.css';

const gyMoney = (value: unknown) => formatAmount(value, '$');

/**
 * [BOOK-S6b · owner C3 28 Oct 2026] A bookable listing's sheet on the store
 * page: where it happens and a free time, then "Book". Nothing is reserved
 * here: the listing goes in the cart and checkout books the time.
 */
export function BookingSheet({
  item, vendorName, vendorAddress, price, busy, error, onBook, onClose,
}: {
  item: MenuItem;
  vendorName: string;
  vendorAddress: string | null;
  price: number | null;
  busy: boolean;
  error: string | null;
  onBook: (_appointment: PendingAppointment) => void;
  onClose: () => void;
}) {
  const [picked, setPicked] = useState<PendingAppointment | null>(null);
  return (
    <Sheet labelledBy="booking-sheet-title" onClose={onClose} className={styles.sheet}>
      <div className={styles.sheetHeader}>
        <div className={styles.sheetHeading}>
          <h2 id="booking-sheet-title" className={styles.modalTitle}>{item.name}</h2>
          {item.description ? <p className={styles.itemDescription}>{item.description}</p> : null}
        </div>
        <button data-modal-initial-focus type="button" className={styles.closeButton} onClick={onClose} aria-label="Close booking">
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
          onClick={() => { if (picked && !busy) onBook(picked); }}
        >
          {busy ? 'Adding…' : picked ? `Book ${formatAppointmentClock(picked.slotStart)} · ${gyMoney(price)}` : 'Pick a time'}
        </button>
      </div>
    </Sheet>
  );
}
