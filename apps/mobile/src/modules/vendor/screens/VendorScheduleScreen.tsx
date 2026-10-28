/** @jsxImportSource react */
import { useState } from 'react';
import { Pressable, RefreshControl, ScrollView, View } from 'react-native';
import { color, space } from '@swift/ui';
import { usePullToRefresh } from '../../../hooks/usePullToRefresh';
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
  useVendorMenu,
  type VendorBooking,
  type VendorBookingException,
} from '../../../hooks/vendorops';
import { money } from '../../../lib/money';
import { errorMessage } from '../../../lib/apiError';
import { touchTarget } from '../../../kit/touch-target';
import { addAppointmentDays, appointmentDayKey, formatAppointmentClock, formatAppointmentDay } from '../../../lib/appointmentTime';
import { MoveBookingSheet, bookingMovable } from '../MoveBookingSheet';
import { NO_SHOW_WORDS, bookingNoShowOpen } from '../noShow';
import { NoShowConfirm, useStartClock } from '../NoShowConfirm';

/** [UI-SWEEP, REVIEW-F 07:08Z] A booking's words. This is BookingStatus
 *  (RESERVED, CONFIRMED, COMPLETED, CANCELLED), its own vocabulary, not an
 *  order's. GET /vendor/bookings drops only CANCELLED, so a COMPLETED
 *  appointment is served, and it used to read 'Reserved'. A status this build
 *  was not taught (newer server, older OTA) says so, never a guess. */
export function bookingStatusPill(status: string): { label: string; tone: 'success' | 'neutral' } {
  switch (status) {
    case 'RESERVED': return { label: 'Reserved', tone: 'neutral' };
    case 'CONFIRMED': return { label: 'Confirmed', tone: 'success' };
    case 'COMPLETED': return { label: 'Completed', tone: 'neutral' };
    case 'CANCELLED': return { label: 'Cancelled', tone: 'neutral' };
    default: return { label: 'Status unavailable', tone: 'neutral' };
  }
}

function AppointmentCard({ b, onMove, onNoShow }: { b: VendorBooking; onMove?: () => void; onNoShow: (orderId: string) => void }) {
  const pill = bookingStatusPill(b.status);
  // [BOOK-NS-APP · owner B3] A confirmed booking whose time has started: "Customer didn't come" (the card draws
  // again at the start, so it appears then).
  const now = useStartClock(b.status === 'CONFIRMED' ? b.slotStart : null);
  const noShow = bookingNoShowOpen(b, now) ? b.orderId : null;
  return (
    <Card style={{ marginBottom: space.sm }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md }}>
        <View style={{ alignItems: 'center', minWidth: 60 }}>
          <T variant="body" weight="bold">{formatAppointmentClock(b.slotStart)}</T>
          <T variant="caption" tone="muted">{formatAppointmentClock(b.slotEnd)}</T>
        </View>
        <View style={{ width: 1, alignSelf: 'stretch', backgroundColor: color.border.subtle }} />
        <View style={{ flex: 1 }}>
          <T variant="body" weight="semibold" numberOfLines={1}>{b.serviceName}</T>
          <T variant="caption" tone="muted" numberOfLines={1}>
            {b.customer?.firstName ?? 'Customer'}{b.price ? ` · ${money(b.price)}` : ''}
          </T>
        </View>
        <TonePill tone={pill.tone} label={pill.label} />
      </View>
      {/* [BOOK-S5a · owner B2] Move it to another free time of the same service. */}
      {onMove || noShow ? (
        <View style={{ flexDirection: 'row', justifyContent: 'flex-end', gap: space.lg, marginTop: space.sm }}>
          {noShow ? <LinkText label={NO_SHOW_WORDS.button} onPress={() => onNoShow(noShow)} /> : null}
          {onMove ? <LinkText label="Move" onPress={onMove} /> : null}
        </View>
      ) : null}
    </Card>
  );
}

/** The provider's DAY CALENDAR (scheduling spec 2.2): 7-day strip → the
 *  chosen day's timeline — booked slots as cards, blocked time as quiet
 *  hatched rows with one-tap unblock — plus "Block time" (full day or a
 *  window, two taps for a funeral afternoon). Fed by GET /vendor/bookings +
 *  /vendor/bookings/exceptions; the socket nudge refetches instantly. */
export function VendorScheduleScreen({ navigation }: any) {
  const q = useVendorBookings();
  const exceptionsQ = useVendorBookingExceptions();
  // [UI-SWEEP, REVIEW-F 07:08Z] Names a one-listing block. A label only: when
  // the menu is not loaded the block says 'One listing', never the whole store.
  const menuQ = useVendorMenu();
  // [UI-SWEEP U33] Pull to refresh like the sibling lists; the spinner follows the pull only (hooks/usePullToRefresh).
  const pull = usePullToRefresh(() => Promise.all([q.refetch(), exceptionsQ.refetch()]));
  const createBlock = useCreateBookingException();
  const deleteBlock = useDeleteBookingException();
  const [dayKey, setDayKey] = useState(() => appointmentDayKey(new Date()));
  const [blocking, setBlocking] = useState(false);
  const [fullDay, setFullDay] = useState(true);
  const [blockStart, setBlockStart] = useState('13:00');
  const [blockEnd, setBlockEnd] = useState('17:00');
  const [blockReason, setBlockReason] = useState('');
  const [moving, setMoving] = useState<VendorBooking | null>(null);
  // [BOOK-NS-APP] The order whose "Customer didn't come" is being asked (NoShowConfirm is mounted only then).
  const [noShowFor, setNoShowFor] = useState<string | null>(null);

  const rows: VendorBooking[] = q.data ?? [];
  const exceptions: VendorBookingException[] = exceptionsQ.data ?? [];

  // The strip follows the market calendar, including near UTC midnight.
  const strip = Array.from({ length: 7 }, (_, i) => {
    const key = addAppointmentDays(appointmentDayKey(new Date()), i);
    return {
      key,
      label: i === 0 ? 'Today' : formatAppointmentDay(key),
    };
  });
  const dayBookings = rows.filter((b) => appointmentDayKey(b.slotStart) === dayKey);
  const dayBlocks = exceptions.filter((e) => e.date.slice(0, 10) === dayKey);
  const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
  const blockValid = fullDay || (HHMM.test(blockStart) && HHMM.test(blockEnd) && blockStart < blockEnd);

  // [UI-SWEEP, web #2013 twin] The popup closes only when the block is saved.
  // It used to close on ANY answer, so a refused block vanished without a
  // word and the provider believed the afternoon was blocked.
  const submitBlock = () => {
    createBlock.mutate(
      {
        date: dayKey,
        ...(fullDay ? {} : { start: blockStart, end: blockEnd }),
        ...(blockReason.trim() ? { reason: blockReason.trim() } : {}),
      },
      { onSuccess: () => setBlocking(false) },
    );
  };
  const openBlocking = () => {
    createBlock.reset();
    setBlocking(true);
  };
  const blockWhen = (e: VendorBookingException) => (e.start ? `${e.start}–${e.end}` : 'all day');
  // [UI-SWEEP, REVIEW-F 07:08Z] A block with an itemId closes ONE listing; it
  // used to read 'Blocked · all day', as if the whole store were closed.
  const listingNames = new Map<string, string>();
  for (const c of (menuQ.data ?? []) as Array<{ items?: Array<{ id: string; name: string }> }>) {
    for (const it of c.items ?? []) listingNames.set(it.id, it.name);
  }
  const blockListing = (e: VendorBookingException) => (e.itemId ? listingNames.get(e.itemId) ?? null : null);
  const blockTitle = (e: VendorBookingException) => {
    if (!e.itemId) return `Blocked · ${blockWhen(e)}`;
    return `${blockListing(e) ?? 'One listing'} blocked · ${blockWhen(e)}`;
  };
  const blockSpoken = (e: VendorBookingException) => {
    if (!e.itemId) return blockWhen(e);
    return `${blockListing(e) ?? 'one listing'}, ${blockWhen(e)}`;
  };

  return (
    <Screen>
      <SubHeader title="Schedule" navigation={navigation} hideBack action={{ label: 'Block time', onPress: openBlocking }} />
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
      ) : exceptionsQ.isError ? (
        // [UI-SWEEP, web #2013 twin] Failure first: a failed blocked-time read
        // never reads as "No bookings this day" (the day may be blocked).
        <ErrorState message="We couldn't load your blocked time. Check your connection and try again." onRetry={() => exceptionsQ.refetch()} />
      ) : (
        <ScrollView
          contentContainerStyle={{ paddingHorizontal: GUTTER, paddingBottom: space['3xl'] }}
          showsVerticalScrollIndicator={false}
          refreshControl={<RefreshControl refreshing={pull.refreshing} onRefresh={() => { void pull.onRefresh(); }} tintColor={color.brand[500]} />}
        >
          {deleteBlock.isError ? (
            // [UI-SWEEP, web #2013 twin] A refused unblock is said, never silent.
            <T variant="caption" tone="error" style={{ marginBottom: space.sm }}>
              {errorMessage(deleteBlock.error, 'Couldn’t remove that block. Try again.')}
            </T>
          ) : null}
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
                  {blockTitle(e)}
                </T>
                {e.reason ? (
                  <T variant="caption" tone="muted" numberOfLines={1}>
                    {e.reason}
                  </T>
                ) : null}
              </View>
              <Pressable
                onPress={() => deleteBlock.mutate(e.id)}
                disabled={deleteBlock.isPending}
                hitSlop={10}
                accessibilityRole="button"
                accessibilityLabel={`Remove block, ${blockSpoken(e)}`}
                accessibilityState={{ disabled: deleteBlock.isPending }}
                style={touchTarget(18)}
              >
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
            dayBookings.map((b) => <AppointmentCard key={b.id} b={b} onMove={bookingMovable(b) ? () => setMoving(b) : undefined} onNoShow={setNoShowFor} />)
          )}
        </ScrollView>
      )}

      {/* Mounted only while a booking is being moved (its free-times read runs only then). */}
      {moving ? <MoveBookingSheet booking={moving} onClose={() => setMoving(null)} /> : null}
      {/* [BOOK-NS-APP · owner B3] Asks once; stays up with the server's refusal or its closed state. */}
      {noShowFor ? <NoShowConfirm orderId={noShowFor} onClose={() => setNoShowFor(null)} /> : null}

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
        {createBlock.isError ? (
          // [UI-SWEEP, web #2013 twin] The refusal stays on screen with the form.
          <T variant="caption" tone="error" center style={{ alignSelf: 'stretch', marginBottom: space.md }}>
            {errorMessage(createBlock.error, 'Couldn’t block that time. Try again.')}
          </T>
        ) : null}
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
