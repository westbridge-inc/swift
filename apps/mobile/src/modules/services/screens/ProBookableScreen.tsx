/** @jsxImportSource react */
import React, { useEffect, useState } from 'react';
import { ScrollView, View } from 'react-native';
import { color, radius, space } from '@swift/ui';
import { Card, Chip, ErrorState, Header, LabeledInput, LoadingBlock, PillButton, Screen, SectionHeader, Switch, T, TonePill } from '../../../kit';
import {
  useAddOffering,
  useAddTimeOff,
  useMyBookable,
  useRemoveTimeOff,
  useSaveProHours,
  useUpdateOffering,
} from '../../../hooks';
import { appointmentDayKey, formatAppointmentDay } from '../../../lib/appointmentTime';
import { moneyExact } from '../../../lib/money';
import { parseServiceQuoteInput, serviceJobErrorMessage } from '../../../lib/serviceJobPresentation';
import { bookingDays, durationLabel, hoursSummary, normalizeClock, WEEKDAY_NAMES, withDayWindows, type HoursWindow } from '../../../lib/proBooking';

interface MyOffering { id: string; name: string; durationMinutes: number; price: number; active: boolean }
interface MyBookable {
  bookable: boolean;
  agreementAccepted?: boolean;
  offerings: MyOffering[];
  weeklyHours: HoursWindow[];
  timeOff: Array<{ id: string; date: string; start: string | null; end: string | null }>;
}

const LENGTHS = [30, 45, 60, 90, 120];

/** Add a service, or change one (name, length, price). The server checks every value. */
function OfferingForm({ existing, onDone }: { existing?: MyOffering; onDone: () => void }) {
  const add = useAddOffering();
  const update = useUpdateOffering();
  const [name, setName] = useState(existing?.name ?? '');
  const [minutes, setMinutes] = useState<number>(existing?.durationMinutes ?? 60);
  const [price, setPrice] = useState(existing ? String(existing.price) : '');
  const amount = parseServiceQuoteInput(price);
  const valid = name.trim().length >= 2 && amount != null;
  const pending = add.isPending || update.isPending;
  const error = add.error ?? update.error;
  const save = () => {
    if (!valid || amount == null) return;
    const input = { name: name.trim(), durationMinutes: minutes, price: amount };
    if (existing) update.mutate({ id: existing.id, ...input }, { onSuccess: onDone });
    else add.mutate(input, { onSuccess: onDone });
  };
  return (
    <View style={{ marginTop: space.md, padding: space.lg, borderRadius: radius.lg, backgroundColor: color.surface.sunken, gap: space.md }}>
      <LabeledInput label="Service name" value={name} onChangeText={setName} placeholder="e.g. Maths lesson, Deep clean" maxLength={80} />
      <T variant="label" weight="semibold">How long it takes</T>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm }}>
        {(LENGTHS.includes(minutes) ? LENGTHS : [...LENGTHS, minutes].sort((a, b) => a - b)).map((m) => (
          <Chip key={m} label={durationLabel(m)} selected={m === minutes} onPress={() => setMinutes(m)} style={{ height: 36, paddingHorizontal: space.md }} />
        ))}
      </View>
      <LabeledInput label="Price (GYD, cash at the appointment)" value={price} onChangeText={setPrice} placeholder="e.g. 3000" keyboardType="decimal-pad" />
      {error ? <T variant="label" tone="error">{serviceJobErrorMessage(error, 'Couldn’t save this service. Try again.')}</T> : null}
      <PillButton label={!valid ? 'Enter a name and a price' : existing ? 'Save changes' : 'Add service'} size="md" disabled={!valid} loading={pending} onPress={save} />
      <PillButton label="Close" variant="soft" size="md" disabled={pending} onPress={onDone} />
    </View>
  );
}

/** One weekday's opening windows, edited locally; the whole week is saved at once. */
function DayHours({ day, windows, onChange }: { day: number; windows: HoursWindow[]; onChange: (w: Array<{ start: string; end: string }>) => void }) {
  const [start, setStart] = useState('09:00');
  const [end, setEnd] = useState('17:00');
  const s = normalizeClock(start);
  const e = normalizeClock(end);
  const ok = s != null && e != null && s < e;
  return (
    <View style={{ paddingVertical: space.sm, gap: space.sm }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm, flexWrap: 'wrap' }}>
        <T variant="label" weight="semibold" style={{ width: 96 }}>{WEEKDAY_NAMES[day]}</T>
        {windows.length === 0 ? <T variant="caption" tone="muted">Closed</T> : null}
        {windows.map((w) => (
          <Chip
            key={`${w.start}-${w.end}`}
            label={`${w.start}–${w.end}  ✕`}
            selected
            onPress={() => onChange(windows.filter((x) => x !== w).map(({ start: a, end: b }) => ({ start: a, end: b })))}
            style={{ height: 34, paddingHorizontal: space.md }}
          />
        ))}
      </View>
      <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: space.sm }}>
        <LabeledInput value={start} onChangeText={setStart} placeholder="09:00" containerStyle={{ flex: 1 }} accessibilityLabel={`${WEEKDAY_NAMES[day]} opens`} />
        <LabeledInput value={end} onChangeText={setEnd} placeholder="17:00" containerStyle={{ flex: 1 }} accessibilityLabel={`${WEEKDAY_NAMES[day]} closes`} />
        <PillButton
          label="Add"
          size="sm"
          variant="soft"
          disabled={!ok}
          onPress={() => { if (ok) onChange([...windows.map(({ start: a, end: b }) => ({ start: a, end: b })), { start: s!, end: e! }]); }}
        />
      </View>
    </View>
  );
}

/**
 * [BOOK-P1/P3] A pro's bookable services, weekly hours and time off — what customers book from (P2). The
 * pro's own settings, read and written by the server routes (behind INSTANT_BOOKING); every check (a
 * bookable trade, overlapping hours, a past day, the caps) is the server's and its words are shown.
 */
export function ProBookableScreen() {
  const q = useMyBookable<MyBookable>();
  const saveHours = useSaveProHours();
  const addOff = useAddTimeOff();
  const removeOff = useRemoveTimeOff();
  const toggle = useUpdateOffering();
  const [editing, setEditing] = useState<string | 'new' | null>(null);
  const [hours, setHours] = useState<HoursWindow[] | null>(null);
  const [offDay, setOffDay] = useState<string | null>(null);
  const [offWhole, setOffWhole] = useState(true);
  const [offStart, setOffStart] = useState('09:00');
  const [offEnd, setOffEnd] = useState('12:00');
  const [offNote, setOffNote] = useState<string | null>(null);
  const data = q.data;

  useEffect(() => { if (data && hours === null) setHours(data.weeklyHours); }, [data, hours]);

  if (q.isPending) return (<Screen><Header title="Bookable services" /><LoadingBlock /></Screen>);
  if (q.isError || !data) {
    return (
      <Screen>
        <Header title="Bookable services" />
        <View style={{ flex: 1, paddingHorizontal: space['2xl'], justifyContent: 'center' }}>
          <ErrorState message={serviceJobErrorMessage(q.error, 'Couldn’t load your bookable services.')} onRetry={() => void q.refetch()} />
        </View>
      </Screen>
    );
  }

  const draft = hours ?? data.weeklyHours;
  const hoursChanged = JSON.stringify(draft) !== JSON.stringify(data.weeklyHours);
  const today = appointmentDayKey(new Date());
  const offStartOk = offWhole || (normalizeClock(offStart) != null && normalizeClock(offEnd) != null && normalizeClock(offStart)! < normalizeClock(offEnd)!);
  const live = data.offerings.some((o) => o.active) && data.weeklyHours.length > 0;

  return (
    <Screen>
      <Header title="Bookable services" />
      <ScrollView contentContainerStyle={{ paddingHorizontal: space['2xl'], paddingBottom: space['3xl'], gap: space.lg }} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
        {!data.bookable ? (
          <Card style={{ backgroundColor: color.soft.info }}>
            <T variant="label" tone="info">Your service does not take bookings from a list yet. Customers can still ask you for a quote.</T>
          </Card>
        ) : (
          <Card style={{ gap: space.xs }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm, flexWrap: 'wrap' }}>
              <T variant="heading">Customers book you</T>
              <TonePill
                label={data.agreementAccepted && live ? 'Open for bookings' : 'Not open yet'}
                tone={data.agreementAccepted && live ? 'success' : 'neutral'}
              />
            </View>
            <T variant="caption" tone="muted">
              {data.agreementAccepted === false
                ? 'Customers can book you from this list once you have accepted the updated provider agreement. Until then they can still ask you for a quote.'
                : !live
                  ? 'Add at least one service and your weekly hours, and customers can book a time from your list.'
                  : 'Bookings from your list are confirmed at once. Customers pay you cash at the appointment. You can move or cancel a booking from My jobs.'}
            </T>
          </Card>
        )}

        <SectionHeader title="Your services" />
        {data.offerings.length === 0 ? <T variant="caption" tone="muted">No services yet.</T> : null}
        {data.offerings.map((o) => (
          <Card key={o.id}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md }}>
              <View style={{ flex: 1 }}>
                <T variant="body" weight="semibold">{o.name}</T>
                <T variant="caption" tone="muted" style={{ marginTop: 2 }}>{`${durationLabel(o.durationMinutes)} · ${moneyExact(o.price)}`}</T>
              </View>
              <Switch
                value={o.active}
                accessibilityLabel={`${o.name} ${o.active ? 'on' : 'off'}`}
                disabled={toggle.isPending || !data.bookable}
                onValueChange={(active) => toggle.mutate({ id: o.id, active })}
              />
            </View>
            {editing === o.id ? <OfferingForm existing={o} onDone={() => setEditing(null)} /> : (
              data.bookable ? <PillButton label="Edit" variant="soft" size="sm" style={{ marginTop: space.md, alignSelf: 'flex-start' }} onPress={() => setEditing(o.id)} /> : null
            )}
          </Card>
        ))}
        {toggle.isError ? <T variant="label" tone="error">{serviceJobErrorMessage(toggle.error, 'Couldn’t change this service. Try again.')}</T> : null}
        {data.bookable ? (editing === 'new' ? <OfferingForm onDone={() => setEditing(null)} /> : (
          <PillButton label="Add a service" icon="plus" variant="soft" size="md" onPress={() => setEditing('new')} />
        )) : null}

        {data.bookable ? (
          <>
            <SectionHeader title="Weekly hours" style={{ marginTop: space.lg }} />
            <T variant="caption" tone="muted">
              {hoursSummary(data.weeklyHours).length ? hoursSummary(data.weeklyHours).join(' · ') : 'No hours yet: nobody can book you until you add some.'}
            </T>
            <Card>
              {WEEKDAY_NAMES.map((_, d) => (
                <DayHours key={d} day={d} windows={draft.filter((w) => w.dayOfWeek === d)} onChange={(w) => setHours(withDayWindows(draft, d, w))} />
              ))}
            </Card>
            {saveHours.isError ? <T variant="label" tone="error">{serviceJobErrorMessage(saveHours.error, 'Couldn’t save your hours. Try again.')}</T> : null}
            <PillButton
              label={hoursChanged ? 'Save hours' : 'Hours saved'}
              size="md"
              disabled={!hoursChanged}
              loading={saveHours.isPending}
              onPress={() => saveHours.mutate(draft, { onSuccess: () => setHours(null) })}
            />

            <SectionHeader title="Time off" style={{ marginTop: space.lg }} />
            <T variant="caption" tone="muted">Time off stops new bookings. It never cancels one already booked: move or cancel those from My jobs.</T>
            {data.timeOff.map((t) => (
              <Card key={t.id} style={{ flexDirection: 'row', alignItems: 'center', gap: space.md }}>
                <T variant="body" style={{ flex: 1 }}>{`${formatAppointmentDay(t.date)}${t.start && t.end ? ` · ${t.start}–${t.end}` : ' · all day'}`}</T>
                <PillButton label="Remove" variant="soft" size="sm" loading={removeOff.isPending} onPress={() => removeOff.mutate(t.id)} />
              </Card>
            ))}
            <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ flexGrow: 0 }} contentContainerStyle={{ gap: space.md }}>
              {bookingDays(today, 30, undefined).map((d) => (
                <Chip key={d.key} label={d.label} selected={offDay === d.key} onPress={() => { setOffDay(d.key); setOffNote(null); }} style={{ height: 40, paddingHorizontal: space.lg }} />
              ))}
            </ScrollView>
            {offDay ? (
              <View style={{ gap: space.sm }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md }}>
                  <T variant="label" style={{ flex: 1 }}>All day</T>
                  <Switch value={offWhole} onValueChange={setOffWhole} accessibilityLabel="Time off all day" />
                </View>
                {!offWhole ? (
                  <View style={{ flexDirection: 'row', gap: space.sm }}>
                    <LabeledInput label="From" value={offStart} onChangeText={setOffStart} placeholder="09:00" containerStyle={{ flex: 1 }} />
                    <LabeledInput label="To" value={offEnd} onChangeText={setOffEnd} placeholder="12:00" containerStyle={{ flex: 1 }} />
                  </View>
                ) : null}
                {addOff.isError ? <T variant="label" tone="error">{serviceJobErrorMessage(addOff.error, 'Couldn’t add this time off. Try again.')}</T> : null}
                <PillButton
                  label={`Add time off · ${formatAppointmentDay(offDay)}`}
                  size="md"
                  disabled={!offStartOk}
                  loading={addOff.isPending}
                  onPress={() => addOff.mutate(
                    offWhole ? { date: offDay } : { date: offDay, start: normalizeClock(offStart)!, end: normalizeClock(offEnd)! },
                    {
                      onSuccess: (res: any) => {
                        const clashing = Number(res?.clashingBookings ?? 0);
                        setOffNote(clashing > 0
                          ? `Added. You still have ${clashing} booked ${clashing === 1 ? 'job' : 'jobs'} in this time: move or cancel ${clashing === 1 ? 'it' : 'them'} from My jobs.`
                          : 'Added.');
                        setOffDay(null);
                      },
                    },
                  )}
                />
              </View>
            ) : null}
            {offNote ? <T variant="label" tone={offNote === 'Added.' ? 'success' : 'warning'}>{offNote}</T> : null}
          </>
        ) : null}
      </ScrollView>
    </Screen>
  );
}
