/** @jsxImportSource react */
import { useState } from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import { color, space } from '@swift/ui';
import { Feather } from '@expo/vector-icons';
import {
  Card,
  Chip,
  EmptyState,
  ErrorState,
  LabeledInput,
  LinkText,
  LoadingBlock,
  PillButton,
  PopupCard,
  PopupTitle,
  Screen,
  T,
  TonePill,
} from '../../../kit';
import { BrandSwitch } from '../../../kit/controls';
import { GUTTER, SubHeader } from '../shared';
import {
  useVendorBookings,
  useVendorBookingExceptions,
  useCreateBookingException,
  useDeleteBookingException,
  type VendorBooking,
  type VendorBookingException,
} from '../../../hooks/vendorops';
import { money } from '../../../lib/money';

/** Slot instants carry LOCAL wall-clock time on their UTC face (the booking
 *  convention, same as the customer picker) — format in UTC or a UTC-4 phone
 *  shows a 9:00 appointment as 5:00 (found live, SCH-F). */
function fmtClock(iso: string) {
  const d = new Date(iso);
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', timeZone: 'UTC' });
}

function AppointmentCard({ b }: { b: VendorBooking }) {
  return (
    <Card style={{ flexDirection: 'row', alignItems: 'center', gap: space.md, marginBottom: space.sm }}>
      <View style={{ alignItems: 'center', minWidth: 60 }}>
        <T variant="body" weight="bold">{fmtClock(b.slotStart)}</T>
        <T variant="caption" tone="muted">{fmtClock(b.slotEnd)}</T>
      </View>
      <View style={{ width: 1, alignSelf: 'stretch', backgroundColor: color.border.subtle }} />
      <View style={{ flex: 1 }}>
        <T variant="body" weight="semibold" numberOfLines={1}>{b.serviceName}</T>
        <T variant="caption" tone="muted" numberOfLines={1}>
          {b.customer?.firstName ?? 'Customer'}{b.price ? ` · ${money(b.price)}` : ''}
        </T>
      </View>
      <TonePill tone={b.status === 'CONFIRMED' ? 'success' : 'neutral'} label={b.status === 'CONFIRMED' ? 'Confirmed' : 'Reserved'} />
    </Card>
  );
}

/** UTC-face day key — matches the booking convention end to end. */
function dayKeyOf(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

/** The provider's DAY CALENDAR (scheduling spec 2.2): 7-day strip → the
 *  chosen day's timeline — booked slots as cards, blocked time as quiet
 *  hatched rows with one-tap unblock — plus "Block time" (full day or a
 *  window, two taps for a funeral afternoon). Fed by GET /vendor/bookings +
 *  /vendor/bookings/exceptions; the socket nudge refetches instantly. */
export function VendorScheduleScreen({ navigation }: any) {
  const q = useVendorBookings();
  const exceptionsQ = useVendorBookingExceptions();
  const createBlock = useCreateBookingException();
  const deleteBlock = useDeleteBookingException();
  const [dayKey, setDayKey] = useState(() => dayKeyOf(new Date()));
  const [blocking, setBlocking] = useState(false);
  const [fullDay, setFullDay] = useState(true);
  const [blockStart, setBlockStart] = useState('13:00');
  const [blockEnd, setBlockEnd] = useState('17:00');
  const [blockReason, setBlockReason] = useState('');

  const rows: VendorBooking[] = q.data ?? [];
  const exceptions: VendorBookingException[] = exceptionsQ.data ?? [];

  // The strip: today + 6, on the UTC face like every slot instant.
  const strip = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(Date.now() + i * 24 * 60 * 60 * 1000);
    return {
      key: dayKeyOf(d),
      label: i === 0 ? 'Today' : d.toLocaleDateString([], { weekday: 'short', day: 'numeric', timeZone: 'UTC' }),
    };
  });
  const dayBookings = rows.filter((b) => dayKeyOf(new Date(b.slotStart)) === dayKey);
  const dayBlocks = exceptions.filter((e) => dayKeyOf(new Date(e.date)) === dayKey);
  const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
  const blockValid = fullDay || (HHMM.test(blockStart) && HHMM.test(blockEnd) && blockStart < blockEnd);

  const submitBlock = () => {
    createBlock.mutate(
      {
        date: dayKey,
        ...(fullDay ? {} : { start: blockStart, end: blockEnd }),
        ...(blockReason.trim() ? { reason: blockReason.trim() } : {}),
      },
      { onSettled: () => setBlocking(false) },
    );
  };

  return (
    <Screen>
      <SubHeader title="Schedule" navigation={navigation} hideBack action={{ label: 'Block time', onPress: () => setBlocking(true) }} />
      <View style={{ paddingHorizontal: GUTTER, marginBottom: space.md }}>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: space.sm }}>
          {strip.map((d) => (
            <Chip key={d.key} label={d.label} selected={d.key === dayKey} onPress={() => setDayKey(d.key)} />
          ))}
        </ScrollView>
      </View>
      {q.isLoading || exceptionsQ.isLoading ? (
        <LoadingBlock />
      ) : q.isError ? (
        <ErrorState message="We couldn't load your schedule. Check your connection and try again." onRetry={() => q.refetch()} />
      ) : (
        <ScrollView contentContainerStyle={{ paddingHorizontal: GUTTER, paddingBottom: space['3xl'] }} showsVerticalScrollIndicator={false}>
          {dayBlocks.map((e) => (
            <Card
              key={e.id}
              style={{
                flexDirection: 'row', alignItems: 'center', gap: space.md, marginBottom: space.sm,
                backgroundColor: color.surface.sunken, borderWidth: 1, borderColor: color.border.subtle,
              }}
            >
              <Feather name="slash" size={16} color={color.text.muted} />
              <View style={{ flex: 1 }}>
                <T variant="body" weight="semibold">
                  {e.start ? `Blocked · ${e.start}–${e.end}` : 'Blocked · all day'}
                </T>
                {e.reason ? (
                  <T variant="caption" tone="muted" numberOfLines={1}>
                    {e.reason}
                  </T>
                ) : null}
              </View>
              <Pressable onPress={() => deleteBlock.mutate(e.id)} hitSlop={10} accessibilityLabel="Remove block">
                {({ pressed }) => <Feather name="x" size={18} color={color.text.muted} style={{ opacity: pressed ? 0.5 : 1 }} />}
              </Pressable>
            </Card>
          ))}
          {dayBookings.length === 0 && dayBlocks.length === 0 ? (
            <EmptyState
              icon="calendar"
              title="No bookings this day"
              body="Your open hours are visible to customers — reservations land here."
            />
          ) : (
            dayBookings.map((b) => <AppointmentCard key={b.id} b={b} />)
          )}
        </ScrollView>
      )}

      {/* Block time — two taps for a funeral afternoon. */}
      <PopupCard visible={blocking} onClose={() => setBlocking(false)}>
        <PopupTitle variant="body" weight="bold" center>
          Block time
        </PopupTitle>
        <T variant="caption" tone="muted" center style={{ marginTop: space.xs, marginBottom: space.lg }}>
          Customers won't see these slots. Nothing is shown as a reason.
        </T>
        <View style={{ alignSelf: 'stretch', flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: space.md }}>
          <T variant="body">All day</T>
          <BrandSwitch value={fullDay} onChange={setFullDay} />
        </View>
        {!fullDay ? (
          <View style={{ alignSelf: 'stretch', flexDirection: 'row', gap: space.md, marginBottom: space.md }}>
            <View style={{ flex: 1 }}>
              <LabeledInput label="From" value={blockStart} onChangeText={setBlockStart} placeholder="13:00" />
            </View>
            <View style={{ flex: 1 }}>
              <LabeledInput label="Until" value={blockEnd} onChangeText={setBlockEnd} placeholder="17:00" />
            </View>
          </View>
        ) : null}
        <View style={{ alignSelf: 'stretch', marginBottom: space.lg }}>
          <LabeledInput label="Note (only you see this)" value={blockReason} onChangeText={setBlockReason} placeholder="Optional" />
        </View>
        {/* [#947's grammar] Disabled says the ask. */}
        <PillButton
          label={blockValid ? 'Block time' : 'Times must be HH:MM, start before end'}
          disabled={!blockValid}
          loading={createBlock.isPending}
          onPress={submitBlock}
          style={{ alignSelf: 'stretch', marginBottom: space.md }}
        />
        <LinkText label="Cancel" tone="muted" onPress={() => setBlocking(false)} />
      </PopupCard>
    </Screen>
  );
}
