'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { getItemSlots, type ItemSlots } from '@/lib/customer';
import { addAppointmentDays, appointmentDayKey, appointmentWeekday, formatAppointmentClock, formatAppointmentDay } from '@/lib/appointmentTime';
import styles from './booking.module.css';

/**
 * [BOOK-S6b · owner C3 28 Oct 2026] "Pick a time" for a bookable listing: the
 * phone's picker (MenuItemScreen, BookingRescheduleCard) on the website. Seven
 * Guyana days; a day the listing has no hours on says so; the times are the
 * server's own free times for that day (GET /customer/items/:id/slots), never
 * worked out here. A picked time the server no longer offers is let go (another
 * customer can take it while this page is open). Checkout stays the judge.
 */
export function SlotPicker({
  itemId, value, onChange, onAnswer, exclude, disabled = false, label = 'Pick a time',
}: {
  itemId: string;
  value: string | null;
  onChange: (_slot: string | null) => void;
  /** Each fresh answer (where the service happens, instant confirmation, duration). */
  onAnswer?: (_answer: ItemSlots) => void;
  /** A time never offered (the customer's own booked time, when moving it). */
  exclude?: string;
  disabled?: boolean;
  label?: string;
}) {
  const today = appointmentDayKey(new Date());
  const [dayOffset, setDayOffset] = useState(() => {
    if (!value) return 0;
    const key = appointmentDayKey(value);
    for (let i = 0; i < 7; i += 1) if (addAppointmentDays(today, i) === key) return i;
    return 0;
  });
  const day = addAppointmentDays(today, dayOffset);
  const [answer, setAnswer] = useState<ItemSlots | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [reload, setReload] = useState(0);
  const latest = useRef({ onChange, onAnswer, value });
  latest.current = { onChange, onAnswer, value };

  useEffect(() => {
    let alive = true;
    setState('loading');
    getItemSlots(itemId, day).then((next) => {
      if (!alive) return;
      setAnswer(next);
      setState('ready');
      latest.current.onAnswer?.(next);
      const picked = latest.current.value;
      if (picked && appointmentDayKey(picked) === day && !next.slots.includes(picked)) latest.current.onChange(null);
    }, () => {
      if (alive) setState('error');
    });
    return () => { alive = false; };
  }, [itemId, day, reload]);

  const excluded = exclude ? new Date(exclude).getTime() : null;
  const times = useMemo(
    () => (answer?.slots ?? []).filter((iso) => excluded === null || new Date(iso).getTime() !== excluded),
    [answer, excluded],
  );
  const bookableWeekdays = answer?.bookableWeekdays;

  return (
    <div className={styles.picker}>
      <p className={styles.label} id={`slot-days-${itemId}`}>{label}</p>
      <div className={styles.days} role="group" aria-labelledby={`slot-days-${itemId}`}>
        {Array.from({ length: 7 }, (_, i) => {
          const key = addAppointmentDays(today, i);
          const closed = bookableWeekdays ? !bookableWeekdays.includes(appointmentWeekday(key)) : false;
          const name = i === 0 ? 'Today' : i === 1 ? 'Tomorrow' : formatAppointmentDay(key);
          return (
            <button
              key={key}
              type="button"
              className={styles.chip}
              aria-pressed={dayOffset === i}
              disabled={disabled || closed}
              onClick={() => { if (dayOffset !== i) { setDayOffset(i); onChange(null); } }}
            >
              {closed ? `${name} · closed` : name}
            </button>
          );
        })}
      </div>
      {state === 'loading' && !answer ? (
        <p className={styles.note} role="status">Checking times…</p>
      ) : state === 'error' ? (
        <div className={styles.actions} role="alert">
          <p className={styles.error}>Couldn’t load available times. Check your connection and try again.</p>
          <button type="button" className={styles.chip} onClick={() => setReload((n) => n + 1)}>Try again</button>
        </div>
      ) : state === 'loading' ? (
        <p className={styles.note} role="status">Checking times…</p>
      ) : times.length === 0 ? (
        <p className={styles.note} role="status">{exclude ? 'No other times left this day — try another.' : 'No times left this day — try another.'}</p>
      ) : (
        <div className={styles.times} role="group" aria-label={`Times on ${dayOffset === 0 ? 'today' : dayOffset === 1 ? 'tomorrow' : formatAppointmentDay(day)}`}>
          {times.map((iso) => (
            <button key={iso} type="button" className={styles.chip} aria-pressed={value === iso} disabled={disabled} onClick={() => onChange(iso)}>
              {formatAppointmentClock(iso)}
            </button>
          ))}
        </div>
      )}
      {state === 'ready' && answer?.durationMinutes ? (
        <p className={styles.note}>Each appointment runs about {answer.durationMinutes} minutes.</p>
      ) : null}
    </div>
  );
}
