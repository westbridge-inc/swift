/** @jsxImportSource react */
import React, { useMemo, useState } from 'react';
import { ScrollView, View } from 'react-native';
import { color, radius, space } from '@swift/ui';
import { Chip, PillButton, T } from '../../kit';
import { useJobSlots, useRescheduleServiceJob } from '../../hooks';
import { appointmentDayKey, formatAppointmentClock, formatAppointmentSlot } from '../../lib/appointmentTime';
import { serviceJobErrorMessage } from '../../lib/serviceJobPresentation';
import { apiErrorCode, bookingDays, moveStripLength } from '../../lib/proBooking';

/**
 * [BOOK-P3 · owner B2] "Change time" on a job booked from a pro's list: another free time for the
 * SAME booked service, from either side (the customer until two hours before it starts, the pro at
 * any time; the server decides). The times are the server's per-job list (GET /jobs/:id/slots: the
 * booked length, the job's own time not counted), so every time shown is one the move takes. A
 * refusal is shown in the server's words. The store appointment's card (BookingRescheduleCard) look.
 */
export function ProJobMoveCard({ job, isCustomer }: { job: { id: string; scheduledFor: string; updatedAt: string }; isCustomer: boolean }) {
  const [open, setOpen] = useState(false);
  const today = appointmentDayKey(new Date());
  const [day, setDay] = useState(() => appointmentDayKey(job.scheduledFor));
  const [slot, setSlot] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  const slotsQ = useJobSlots<{ slots?: string[]; bookableWeekdays?: number[]; horizonDays?: number }>(open ? job.id : '', day);
  const move = useRescheduleServiceJob();
  const days = useMemo(
    // From today, reaching at least a week past the booked day (the server's horizon cuts it).
    () => bookingDays(today, moveStripLength(today, appointmentDayKey(job.scheduledFor)), slotsQ.data?.bookableWeekdays, slotsQ.data?.horizonDays),
    [today, job.scheduledFor, slotsQ.data?.bookableWeekdays, slotsQ.data?.horizonDays],
  );
  const times = slotsQ.data?.slots ?? [];

  if (!open) {
    return (
      <PillButton
        label={isCustomer ? 'Change time' : 'Move booking'}
        variant="soft"
        icon="calendar"
        size="md"
        onPress={() => { setRefusal(null); setDay(appointmentDayKey(job.scheduledFor) < today ? today : appointmentDayKey(job.scheduledFor)); setOpen(true); }}
        style={{ marginTop: space.md }}
      />
    );
  }

  const confirmMove = () => {
    if (!slot || move.isPending) return;
    setRefusal(null);
    move.mutate(
      { id: job.id, scheduledFor: slot, expectedUpdatedAt: String(job.updatedAt), expectedScheduledFor: String(job.scheduledFor) },
      {
        onSuccess: () => { setOpen(false); setSlot(null); },
        onError: (error) => {
          setSlot(null);
          setRefusal(serviceJobErrorMessage(error, 'Couldn’t move this booking. Try again.'));
          if (apiErrorCode(error) === 'SLOT_TAKEN') void slotsQ.refetch();
        },
      },
    );
  };

  return (
    <View style={{ marginTop: space.md, padding: space.lg, borderRadius: radius.lg, backgroundColor: color.surface.sunken }}>
      <T variant="body" weight="bold" accessibilityRole="header">{isCustomer ? 'Change time' : 'Move booking'}</T>
      <T variant="caption" tone="muted" style={{ marginTop: space.xs }}>
        {isCustomer
          ? `Pick another free time for the same service. Your current time (${formatAppointmentSlot(job.scheduledFor)}) stays booked until the move goes through.`
          : `Pick another free time for this booking. The customer is told in the app. It stays at ${formatAppointmentSlot(job.scheduledFor)} until the move goes through.`}
      </T>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginTop: space.md, flexGrow: 0 }} contentContainerStyle={{ gap: space.md }}>
        {days.map((d) => (
          <Chip
            key={d.key}
            label={d.closed ? `${d.label} · closed` : d.label}
            selected={day === d.key}
            onPress={() => {
              if (d.closed) return;
              setDay(d.key);
              setSlot(null);
            }}
            style={{ height: 40, paddingHorizontal: space.lg, opacity: d.closed ? 0.45 : 1 }}
          />
        ))}
      </ScrollView>
      {slotsQ.isPending ? (
        <T variant="label" tone="muted" style={{ marginTop: space.md }}>Checking times…</T>
      ) : slotsQ.isError ? (
        <View style={{ marginTop: space.md, alignItems: 'flex-start', gap: space.sm }}>
          <T variant="label" tone="error">{serviceJobErrorMessage(slotsQ.error, 'Couldn’t load available times. Check your connection and try again.')}</T>
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
      {refusal ? <T variant="label" tone="error" style={{ marginTop: space.md }}>{refusal}</T> : null}
      <View style={{ gap: space.md, marginTop: space.lg }}>
        <PillButton
          label={slot ? `Move to ${formatAppointmentSlot(slot)}` : 'Pick a new time'}
          size="md"
          loading={move.isPending}
          disabled={!slot || move.isPending}
          onPress={confirmMove}
        />
        <PillButton
          label="Keep this time"
          variant="soft"
          size="md"
          disabled={move.isPending}
          onPress={() => { setOpen(false); setSlot(null); setRefusal(null); }}
        />
      </View>
    </View>
  );
}
