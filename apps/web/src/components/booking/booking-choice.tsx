'use client';

import { useEffect, useRef, useState } from 'react';
import type { ItemSlots } from '@/lib/customer';
import { listingConfirmsInstantly } from '@/lib/app-rules';
import { visitModeFor, type HeldTime, type VisitMode } from '@/lib/held-time';
import { SlotPicker } from './slot-picker';
import styles from './booking.module.css';

/**
 * [BOOK-S6b · owner C3 28 Oct 2026] Where and when, for one bookable listing:
 * the phone's item screen for an appointment (MenuItemScreen "Where" and "Pick
 * a time"), word for word. The "Instant confirmation" badge shows only when the
 * server's slots answer says so (INSTANT_BOOKING on and the business's own
 * "Confirm bookings automatically"); with the switch off nothing says
 * "instant". Each complete choice (a free time, and where when the business
 * offers both) is handed up; nothing is reserved here, checkout books it.
 */
export function BookingChoice({
  itemId, vendorName, vendorAddress, initial, disabled = false, onChange,
}: {
  itemId: string;
  vendorName: string;
  vendorAddress: string | null;
  initial?: HeldTime | null;
  disabled?: boolean;
  onChange: (_held: HeldTime | null) => void;
}) {
  const [slot, setSlot] = useState<string | null>(initial?.itemId === itemId ? initial.slotStart : null);
  const [answer, setAnswer] = useState<ItemSlots | null>(null);
  const [visitMode, setVisitMode] = useState<VisitMode>(initial?.mode ?? 'AT_BUSINESS');
  const serviceMode = answer?.serviceMode === 'MOBILE' || answer?.serviceMode === 'BOTH' ? answer.serviceMode : 'AT_BUSINESS';
  const instant = listingConfirmsInstantly(answer);
  const radius = answer?.serviceRadiusKm ? ` (within ${answer.serviceRadiusKm} km)` : '';
  const report = useRef(onChange);
  report.current = onChange;

  useEffect(() => {
    if (!answer) return;
    if (!slot) { report.current(null); return; }
    const mode = visitModeFor(answer.serviceMode, visitMode);
    report.current({
      itemId,
      slotStart: slot,
      ...(mode ? { mode } : {}),
      serviceMode,
      ...(instant ? { instant: true } : {}),
    });
  }, [answer, slot, visitMode, itemId, serviceMode, instant]);

  return (
    <div className={styles.picker}>
      {/* [BOOK-S6a · owner A4] Only the server's own answer earns the badge. */}
      {instant ? (
        <div className={styles.instant}>
          <span className="sw-status sw-status-success">Instant confirmation</span>
          <p className={styles.note}>Pay at your appointment and your time is confirmed as soon as you book.</p>
        </div>
      ) : null}
      <p className={styles.label} id={`booking-where-${itemId}`}>Where</p>
      {serviceMode === 'BOTH' ? (
        <div className={styles.modes} role="group" aria-labelledby={`booking-where-${itemId}`}>
          <button type="button" className={styles.chip} aria-pressed={visitMode === 'AT_BUSINESS'} disabled={disabled} onClick={() => setVisitMode('AT_BUSINESS')}>You go to them</button>
          <button type="button" className={styles.chip} aria-pressed={visitMode === 'MOBILE'} disabled={disabled} onClick={() => setVisitMode('MOBILE')}>They come to you</button>
        </div>
      ) : (
        <p className={styles.note}>
          {serviceMode === 'MOBILE' ? `They come to your address${radius}` : `At ${vendorName}${vendorAddress ? ` — ${vendorAddress}` : ''}`}
        </p>
      )}
      {serviceMode === 'BOTH' && visitMode === 'MOBILE' ? (
        <p className={styles.note}>They travel to your saved address{radius}.</p>
      ) : null}
      <SlotPicker itemId={itemId} value={slot} onChange={setSlot} onAnswer={setAnswer} disabled={disabled} />
    </div>
  );
}
