/** @jsxImportSource react */
import React, { useMemo, useState } from 'react';
import { ScrollView, View } from 'react-native';
import { space } from '@swift/ui';
import { Chip, LinkText, PillButton, PopupCard, PopupTitle, T } from '../../kit';
import { useBookingMoveTimes, useRescheduleVendorBooking, type VendorBooking } from '../../hooks/vendorops';
import { errorMessage } from '../../lib/apiError';
import { addAppointmentDays, appointmentDayKey, appointmentWeekday, formatAppointmentClock, formatAppointmentDay, formatAppointmentSlot } from '../../lib/appointmentTime';

/** [BOOK-S5a · owner B2] A booking the business can move from its Schedule: a live one
 *  (reserved or confirmed) that has not started, whose listing the server named. */
export function bookingMovable(b: Pick<VendorBooking, 'status' | 'slotStart' | 'itemId'>, now = Date.now()): boolean {
  return typeof b.itemId === 'string' && b.itemId.length > 0
    && (b.status === 'RESERVED' || b.status === 'CONFIRMED')
    && new Date(b.slotStart).getTime() > now;
}

/**
 * [BOOK-S5a · owner B2] "Move" on the Schedule: another free time of the SAME service, from the
 * server's own free times (the booking's own time is left out). The server judges the move and
 * tells the customer; a refusal (a time just taken, a finished booking) is shown in its words.
 */
export function MoveBookingSheet({ booking, onClose }: { booking: VendorBooking | null; onClose: () => void }) {
  const [dayOffset, setDayOffset] = useState(0);
  const [slot, setSlot] = useState<string | null>(null);
  const today = appointmentDayKey(new Date());
  const day = addAppointmentDays(today, dayOffset);
  const slotsQ = useBookingMoveTimes(booking?.itemId ?? '', day);
  const move = useRescheduleVendorBooking();
  const current = booking ? new Date(booking.slotStart).getTime() : 0;
  const times = useMemo(
    () => (slotsQ.data?.slots ?? []).filter((iso) => new Date(iso).getTime() !== current),
    [slotsQ.data, current],
  );
  const bookableWeekdays = slotsQ.data?.bookableWeekdays;

  const close = () => {
    if (move.isPending) return;
    setSlot(null);
    setDayOffset(0);
    move.reset();
    onClose();
  };
  const confirm = () => {
    if (!booking || !slot || move.isPending) return;
    move.mutate({ bookingId: booking.id, newSlotStart: slot }, {
      onSuccess: () => { setSlot(null); setDayOffset(0); onClose(); },
      onError: () => setSlot(null),
    });
  };

  return (
    <PopupCard visible={!!booking} onClose={close}>
      <PopupTitle variant="body" weight="bold" center>
        Move this booking
      </PopupTitle>
      {booking ? (
        <T variant="caption" tone="muted" center style={{ marginTop: space.xs, marginBottom: space.lg }}>
          {booking.serviceName} · now {formatAppointmentSlot(booking.slotStart)}. The customer is told the new time.
        </T>
      ) : null}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ alignSelf: 'stretch', flexGrow: 0 }} contentContainerStyle={{ gap: space.sm }}>
        {Array.from({ length: 7 }, (_, i) => {
          const key = addAppointmentDays(today, i);
          const closed = bookableWeekdays ? !bookableWeekdays.includes(appointmentWeekday(key)) : false;
          const label = i === 0 ? 'Today' : formatAppointmentDay(key);
          return (
            <Chip
              key={key}
              label={closed ? `${label} · closed` : label}
              selected={dayOffset === i}
              onPress={() => {
                if (closed) return;
                setDayOffset(i);
                setSlot(null);
              }}
              style={{ height: 38, paddingHorizontal: space.md, opacity: closed ? 0.45 : 1 }}
            />
          );
        })}
      </ScrollView>
      <View style={{ alignSelf: 'stretch', marginTop: space.md }}>
        {slotsQ.isPending ? (
          <T variant="label" tone="muted">Checking times…</T>
        ) : slotsQ.isError ? (
          <View style={{ alignItems: 'flex-start', gap: space.sm }}>
            <T variant="label" tone="error">Couldn’t load the free times. Check your connection and try again.</T>
            <Chip label="Try again" selected={false} onPress={() => void slotsQ.refetch()} style={{ height: 38, paddingHorizontal: space.md }} />
          </View>
        ) : times.length === 0 ? (
          <T variant="label" tone="muted">No other free times this day — try another.</T>
        ) : (
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm }}>
            {times.map((iso) => (
              <Chip key={iso} label={formatAppointmentClock(iso)} selected={slot === iso} onPress={() => setSlot(iso)} style={{ height: 40, paddingHorizontal: space.md }} />
            ))}
          </View>
        )}
      </View>
      {move.isError ? (
        <T variant="caption" tone="error" center style={{ alignSelf: 'stretch', marginTop: space.md }}>
          {errorMessage(move.error, 'Couldn’t move the booking. Try again.')}
        </T>
      ) : null}
      <PillButton
        label={slot ? `Move to ${formatAppointmentSlot(slot)}` : 'Pick a new time'}
        disabled={!slot || move.isPending}
        loading={move.isPending}
        onPress={confirm}
        style={{ alignSelf: 'stretch', marginTop: space.lg, marginBottom: space.md }}
      />
      <LinkText label="Keep this time" tone="muted" disabled={move.isPending} onPress={close} />
    </PopupCard>
  );
}
