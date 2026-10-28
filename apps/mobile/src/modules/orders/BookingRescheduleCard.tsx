/** @jsxImportSource react */
import React, { useMemo, useState } from 'react';
import { ScrollView, View } from 'react-native';
import { color, radius, space } from '@swift/ui';
import { Chip, PillButton, T } from '../../kit';
import { useItemSlots, useRescheduleBooking } from '../../hooks/customer';
import { addAppointmentDays, appointmentDayKey, appointmentWeekday, formatAppointmentClock, formatAppointmentDay, formatAppointmentSlot } from '../../lib/appointmentTime';
import { rescheduleErrorMessage, type AppointmentBookingView } from '../../lib/appointmentBooking';

/**
 * [BOOK-S6a · owner B2 28 Oct 2026] "Change time" on the customer's booking:
 * another free time of the SAME service. Renders only what the server
 * projected: the control appears when the server says a move is allowed now,
 * the times are the server's own free times, and a refusal (a taken time, the
 * two-hour cut-off) is shown in the server's words. When the server says no,
 * its reason is shown instead; when it sends nothing, nothing is shown.
 */
export function BookingRescheduleCard({ orderId, booking }: { orderId: string; booking: AppointmentBookingView }) {
  const [open, setOpen] = useState(false);
  const [dayOffset, setDayOffset] = useState(0);
  const [slot, setSlot] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  const today = appointmentDayKey(new Date());
  const day = addAppointmentDays(today, dayOffset);
  const slotsQ = useItemSlots<{ slots?: string[]; bookableWeekdays?: number[] }>(open ? booking.itemId : '', day);
  const move = useRescheduleBooking();
  const current = new Date(booking.slotStart).getTime();
  // The booking's own time is not a move.
  const times = useMemo(
    () => (slotsQ.data?.slots ?? []).filter((iso) => new Date(iso).getTime() !== current),
    [slotsQ.data, current],
  );
  const bookableWeekdays = slotsQ.data?.bookableWeekdays;

  if (!booking.canReschedule) {
    return booking.rescheduleUnavailable ? (
      <View style={{ marginTop: space.md, padding: space.md, borderRadius: radius.md, backgroundColor: color.soft.info }}>
        <T variant="label" tone="info">{booking.rescheduleUnavailable}</T>
      </View>
    ) : null;
  }

  if (!open) {
    return (
      <PillButton
        label="Change time"
        variant="soft"
        icon="calendar"
        size="md"
        onPress={() => { setRefusal(null); setOpen(true); }}
        style={{ marginTop: space.md }}
      />
    );
  }

  const confirmMove = () => {
    if (!slot || move.isPending) return;
    setRefusal(null);
    move.mutate(
      { orderId, bookingId: booking.bookingId, newSlotStart: slot },
      {
        onSuccess: () => { setOpen(false); setSlot(null); },
        onError: (error) => { setSlot(null); setRefusal(rescheduleErrorMessage(error)); },
      },
    );
  };

  return (
    <View style={{ marginTop: space.md, padding: space.lg, borderRadius: radius.lg, backgroundColor: color.surface.sunken }}>
      <T variant="body" weight="bold" accessibilityRole="header">Change time</T>
      <T variant="caption" tone="muted" style={{ marginTop: space.xs }}>
        Pick another free time for the same service. Your current time stays booked until the new one is confirmed.
      </T>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginTop: space.md, flexGrow: 0 }} contentContainerStyle={{ gap: space.md }}>
        {Array.from({ length: 7 }, (_, i) => {
          const key = addAppointmentDays(today, i);
          const closed = bookableWeekdays ? !bookableWeekdays.includes(appointmentWeekday(key)) : false;
          const label = i === 0 ? 'Today' : i === 1 ? 'Tomorrow' : formatAppointmentDay(key);
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
              style={{ height: 40, paddingHorizontal: space.lg, opacity: closed ? 0.45 : 1 }}
            />
          );
        })}
      </ScrollView>
      {slotsQ.isPending ? (
        <T variant="label" tone="muted" style={{ marginTop: space.md }}>Checking times…</T>
      ) : slotsQ.isError ? (
        <View style={{ marginTop: space.md, alignItems: 'flex-start', gap: space.sm }}>
          <T variant="label" tone="error">Couldn’t load available times. Check your connection and try again.</T>
          <Chip label="Try again" selected={false} onPress={() => void slotsQ.refetch()} style={{ height: 40, paddingHorizontal: space.lg }} />
        </View>
      ) : times.length === 0 ? (
        <T variant="label" tone="muted" style={{ marginTop: space.md }}>No other times left this day — try another.</T>
      ) : (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.md, marginTop: space.md }}>
          {times.map((iso) => (
            <Chip key={iso} label={formatAppointmentClock(iso)} selected={slot === iso} onPress={() => setSlot(iso)} style={{ height: 42, paddingHorizontal: space.lg }} />
          ))}
        </View>
      )}
      {refusal ? (
        <T variant="label" tone="error" style={{ marginTop: space.md }}>{refusal}</T>
      ) : null}
      <View style={{ gap: space.md, marginTop: space.lg }}>
        <PillButton
          label={slot ? `Move to ${formatAppointmentSlot(slot)}` : 'Pick a new time'}
          size="md"
          loading={move.isPending}
          disabled={!slot || move.isPending}
          onPress={confirmMove}
        />
        <PillButton
          label="Keep my time"
          variant="soft"
          size="md"
          disabled={move.isPending}
          onPress={() => { setOpen(false); setSlot(null); setRefusal(null); }}
        />
      </View>
    </View>
  );
}
