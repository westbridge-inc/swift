/** @jsxImportSource react */
import React, { useEffect, useMemo, useState } from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { color, radius, space } from '@swift/ui';
import {
  Card,
  Chip,
  DecorativeIcon,
  EmptyState,
  ErrorState,
  Header,
  LabeledInput,
  LoadingBlock,
  PillButton,
  PopupCard,
  PopupTitle,
  Screen,
  SectionHeader,
  T,
  TonePill,
} from '../../../kit';
import { afterDismiss } from '../../../kit/after-dismiss';
import { useBookPro, useProOfferings, useProSlots } from '../../../hooks';
import { appointmentDayKey, formatAppointmentClock, formatAppointmentSlot } from '../../../lib/appointmentTime';
import { moneyExact } from '../../../lib/money';
import { serviceJobErrorMessage } from '../../../lib/serviceJobPresentation';
import { APPOINTMENT_FREE_CANCEL_HOURS, bookingDays, bookingRefusalRefresh, durationLabel, type ProOfferingsAnswer } from '../../../lib/proBooking';

/** How many days the strip shows (the server's horizon may cut it shorter). */
const DAYS_SHOWN = 30;

/**
 * [BOOK-P3] Book a pro from their list of services: pick a service (its fixed price and length, from
 * the server), a day, one of the server's free times, and book. The server confirms it at once (the
 * pro's list is their standing acceptance), cash at the appointment. Every refusal is shown in the
 * server's words; a taken time reloads the times, a changed price reloads the list.
 * The look is the store appointment's (MenuItemScreen "Pick a time", BookingRescheduleCard).
 */
export function ProBookingScreen({ navigation, route }: any) {
  const providerId: string = route?.params?.providerId ?? '';
  const offeringsQ = useProOfferings<ProOfferingsAnswer>(providerId);
  const book = useBookPro();
  const [offeringId, setOfferingId] = useState<string | null>(null);
  const today = appointmentDayKey(new Date());
  const [day, setDay] = useState<string>(today);
  const [slot, setSlot] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [refusal, setRefusal] = useState<string | null>(null);
  const [booked, setBooked] = useState<string | null>(null);

  const answer = offeringsQ.data;
  const offerings = useMemo(() => answer?.offerings ?? [], [answer]);
  const offering = offerings.find((o) => o.id === offeringId) ?? null;
  const days = useMemo(() => bookingDays(today, DAYS_SHOWN, answer?.bookableWeekdays, answer?.horizonDays), [today, answer?.bookableWeekdays, answer?.horizonDays]);
  const slotsQ = useProSlots<{ slots?: string[] }>(providerId, offering?.id ?? '', day);
  const times = useMemo(() => slotsQ.data?.slots ?? [], [slotsQ.data]);

  // A single service is picked for the customer; a time the server no longer lists is dropped.
  useEffect(() => {
    if (!offeringId && offerings.length === 1) setOfferingId(offerings[0]!.id);
  }, [offeringId, offerings]);
  useEffect(() => {
    if (slot && slotsQ.data && !times.includes(slot)) setSlot(null);
  }, [slot, slotsQ.data, times]);

  const confirm = () => {
    if (!offering || !slot || book.isPending) return;
    setRefusal(null);
    book.mutate(
      { providerId, offeringId: offering.id, scheduledFor: slot, expectedPrice: offering.price, ...(note.trim() ? { note: note.trim() } : {}) },
      {
        onSuccess: () => { setBooked(slot); setSlot(null); setNote(''); },
        onError: (error) => {
          setRefusal(serviceJobErrorMessage(error, 'Couldn’t book this time. Try again.'));
          const reload = bookingRefusalRefresh(error);
          if (reload === 'slots') { setSlot(null); void slotsQ.refetch(); }
          if (reload === 'offerings') { setSlot(null); void offeringsQ.refetch(); }
        },
      },
    );
  };

  return (
    <Screen>
      <Header title={answer?.tradeLabel ? `Book a ${answer.tradeLabel.toLowerCase()}` : 'Book a time'} />
      {offeringsQ.isPending ? (
        <LoadingBlock />
      ) : offeringsQ.isError ? (
        // The server's words: not taking bookings from a list yet, not found, or the feature is off.
        <View style={{ flex: 1, paddingHorizontal: space['2xl'], justifyContent: 'center' }}>
          <ErrorState
            message={serviceJobErrorMessage(offeringsQ.error, 'Couldn’t load this provider’s services. Check your connection and try again.')}
            onRetry={() => void offeringsQ.refetch()}
          />
        </View>
      ) : offerings.length === 0 ? (
        <View style={{ flex: 1, paddingHorizontal: space['2xl'], justifyContent: 'center' }}>
          <EmptyState icon="calendar" title="Nothing to book yet" body="This provider has no services to book right now. You can still ask them for a quote from Services." />
        </View>
      ) : (
        <ScrollView contentContainerStyle={{ paddingHorizontal: space['2xl'], paddingBottom: space['3xl'] }} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
          <SectionHeader title="Choose a service" style={{ marginTop: space.sm }} />
          <View style={{ gap: space.md, marginTop: space.md }}>
            {offerings.map((o) => {
              const selected = o.id === offeringId;
              return (
                <Pressable
                  key={o.id}
                  onPress={() => { setOfferingId(o.id); setSlot(null); setRefusal(null); }}
                  accessibilityRole="radio"
                  accessibilityState={{ selected }}
                  accessibilityLabel={`${o.name}, ${durationLabel(o.durationMinutes)}, ${moneyExact(o.price)}`}
                >
                  <Card style={selected ? { borderWidth: space.xs / 2, borderColor: color.brand[500] } : undefined}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md }}>
                      <View style={{ flex: 1 }}>
                        <T variant="body" weight="semibold">{o.name}</T>
                        <T variant="caption" tone="muted" style={{ marginTop: 2 }}>{durationLabel(o.durationMinutes)}</T>
                      </View>
                      <T variant="body" weight="bold">{moneyExact(o.price)}</T>
                    </View>
                  </Card>
                </Pressable>
              );
            })}
          </View>

          {offering ? (
            <>
              <SectionHeader title="Pick a time" style={{ marginTop: space['2xl'] }} />
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
              ) : slotsQ.isError && !slotsQ.data ? (
                <View style={{ marginTop: space.md, alignItems: 'flex-start', gap: space.sm }}>
                  <T variant="label" tone="error">{serviceJobErrorMessage(slotsQ.error, 'Couldn’t load available times. Check your connection and try again.')}</T>
                  <Chip label="Try again" selected={false} onPress={() => void slotsQ.refetch()} style={{ height: 40, paddingHorizontal: space.lg }} />
                </View>
              ) : times.length === 0 ? (
                <T variant="label" tone="muted" style={{ marginTop: space.md }}>No times left this day — try another.</T>
              ) : (
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.md, marginTop: space.md }}>
                  {times.map((iso) => (
                    <Chip key={iso} label={formatAppointmentClock(iso)} selected={slot === iso} onPress={() => { setSlot(iso); setRefusal(null); }} style={{ height: 42, paddingHorizontal: space.lg }} />
                  ))}
                </View>
              )}
              <T variant="caption" tone="faint" style={{ marginTop: space.sm }}>
                {`Book at least ${Math.round((answer?.minNoticeMinutes ?? 120) / 60)} hours ahead. This appointment runs about ${durationLabel(offering.durationMinutes)}.`}
              </T>

              <LabeledInput
                label="Note for the provider (optional)"
                value={note}
                onChangeText={setNote}
                placeholder="Anything they should know"
                maxLength={500}
                multiline
                containerStyle={{ marginTop: space['2xl'] }}
                style={{ minHeight: 64, textAlignVertical: 'top' }}
              />

              <View style={{ marginTop: space.xl, padding: space.lg, borderRadius: radius.lg, backgroundColor: color.surface.sunken, gap: space.xs }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
                  <TonePill label="Confirmed when you book" tone="success" />
                  <TonePill label="Cash at the appointment" tone="neutral" />
                </View>
                <T variant="caption" tone="muted" style={{ marginTop: space.xs }}>
                  {`You can cancel or move it free in the app until ${APPOINTMENT_FREE_CANCEL_HOURS} hours before it starts.`}
                </T>
              </View>

              {refusal ? <T variant="label" tone="error" style={{ marginTop: space.md }}>{refusal}</T> : null}
              <PillButton
                label={slot ? `Book ${formatAppointmentSlot(slot)} · ${moneyExact(offering.price)}` : 'Pick a time'}
                style={{ marginTop: space.lg }}
                loading={book.isPending}
                disabled={!slot || book.isPending}
                onPress={confirm}
              />
            </>
          ) : null}
        </ScrollView>
      )}

      <PopupCard visible={booked != null} onClose={() => setBooked(null)}>
        <DecorativeIcon style={{ width: space['5xl'] + space['2xl'], height: space['5xl'] + space['2xl'], borderRadius: radius.full, alignItems: 'center', justifyContent: 'center', backgroundColor: color.brand[500] }}>
          <Feather name="check" size={space['3xl']} color={color.white} />
        </DecorativeIcon>
        <PopupTitle variant="title" center style={{ marginTop: space.lg }}>Booking confirmed</PopupTitle>
        <T variant="body" tone="muted" center style={{ marginTop: space.sm }}>
          {booked ? `${offering?.name ?? 'Your appointment'}, ${formatAppointmentSlot(booked)}. Pay cash at the appointment.` : ''}
        </T>
        <PillButton
          label="View my jobs"
          style={{ alignSelf: 'stretch', marginTop: space['2xl'] }}
          onPress={() => {
            setBooked(null);
            afterDismiss(() => navigation?.navigate?.('ServiceJobs'));
          }}
        />
        <PillButton label="Done" variant="soft" style={{ alignSelf: 'stretch', marginTop: space.md }} onPress={() => setBooked(null)} />
      </PopupCard>
    </Screen>
  );
}
