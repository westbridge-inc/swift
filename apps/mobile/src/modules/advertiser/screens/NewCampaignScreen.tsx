/** @jsxImportSource react */
import React, { useMemo, useState } from 'react';
import { Image, Pressable, ScrollView, View } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { useNavigation } from '@react-navigation/native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useQueryClient } from '@tanstack/react-query';
import { Feather } from '@expo/vector-icons';
import { color, radius, space } from '@swift/ui';
import { Card, LabeledInput, LoadingBlock, PillButton, T } from '../../../kit';
import { useAdPlacements, useAdAvailability, useMyAdvertisers } from '../../../hooks/advertiser';
import { adsApi } from '../../../services/api';
import { errorMessage } from '../../../lib/apiError';
import { money } from './AdvertiserHomeScreen';
import {
  AuthSessionBoundaryError,
  requireAuthSessionForPrincipal,
  requireAuthSessionSnapshot,
} from '../../../stores/authStore';
import { quotedTotal, selectionIsContiguous, submittedRange, toggleWeek, type AvailableWeek } from '../../../lib/adWeeks';

// §14.3 — the 5-step New Campaign wizard: ① placement tier cards with live
// prices → ② weeks from the availability API (sold-out greyed) → ③ cities
// (hidden: single-city tenant, E11 — "*" everywhere) → ④ creative with the
// spec card up front → ⑤ review: itemized total (price × weeks), refund
// policy, pay → reserve + checkout with the reservation countdown running.
// The server owns every price and every hold; this screen only renders them.

type Step = 1 | 2 | 4 | 5; // step 3 (cities) is hidden for the single-city tenant

const fmtISO = (d: Date) => d.toISOString().slice(0, 10);

export function NewCampaignScreen() {
  const navigation = useNavigation<any>();
  const queryClient = useQueryClient();
  const insets = useSafeAreaInsets();
  const me = useMyAdvertisers();
  const advertiser = (me.data ?? [])[0];
  const approved = advertiser?.status === 'APPROVED';

  const [step, setStep] = useState<Step>(1);
  const [placement, setPlacement] = useState<any | null>(null);
  const [name, setName] = useState('');
  const [weeks, setWeeks] = useState<string[]>([]); // ISO Mondays
  const [asset, setAsset] = useState<{ uri: string; mime: string; name: string } | null>(null);
  const [headline, setHeadline] = useState('');
  const [ctaLabel, setCtaLabel] = useState('');
  const [destinationValue, setDestinationValue] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [checkoutResult, setCheckoutResult] = useState<any | null>(null);

  const placements = useAdPlacements();

  // ② availability: next 8 weeks for the chosen placement.
  const from = useMemo(() => fmtISO(new Date()), []);
  const to = useMemo(() => fmtISO(new Date(Date.now() + 8 * 7 * 86_400_000)), []);
  const availability = useAdAvailability(placement?.id, '*', from, to);

  // [MOB-052] The weeks you pick are the weeks you pay for. The picker used to
  // let any Mondays be ticked and then submitted startWeek..endWeek — a RANGE —
  // so picking the 1st, 3rd and 5th showed a price for three weeks and reserved
  // five. A range is what the platform sells, so a range is what this chooses.
  const availableWeeks: AvailableWeek[] = useMemo(
    () => ((availability.data ?? []) as any[]).map((w) => ({
      iso: String(w.weekStart).slice(0, 10),
      soldOut: (w.available ?? 0) <= 0,
    })),
    [availability.data],
  );
  const [weekNotice, setWeekNotice] = useState<string | null>(null);
  const onToggleWeek = (w: string) => {
    const next = toggleWeek(weeks, w, availableWeeks);
    setWeekNotice(
      next.refused === 'sold_out' ? 'That week is sold out.'
        : next.refused === 'gap_has_sold_out_week'
          ? 'A week in between is sold out, so the run cannot reach that far. Campaigns book a continuous block of weeks.'
          : null,
    );
    setWeeks(next.weeks);
  };

  const pickImage = async () => {
    const res = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 0.85 });
    const a = res.assets?.[0];
    if (a?.uri) setAsset({ uri: a.uri, mime: a.mimeType ?? 'image/jpeg', name: a.fileName ?? 'creative.jpg' });
  };

  // [MOB-052] The SERVER's formula: price x weeks x cities. The screen used to
  // price the count of ticked weeks and ignore cities, while the invoice
  // multiplied the booked RANGE by the city count.
  const cities = ['*'];
  const total = quotedTotal(placement?.weeklyPrice, weeks.length, cities.length);

  /** ⑤ — the whole money path, honestly sequenced: draft → creative →
   *  reserve (server row-locks the weeks) → checkout (invoice + countdown). */
  const reserveAndPay = async () => {
    if (!advertiser || !placement || weeks.length === 0) return;
    // [MOB-052] The submit path sends a RANGE. This is the invariant that
    // makes that honest: a selection that a range would not reproduce can
    // never be sent, whatever produced it.
    const range = submittedRange(weeks);
    if (!range || !selectionIsContiguous(weeks, availableWeeks)) {
      setError('Those weeks are not a continuous run. Pick a block of weeks and try again.');
      return;
    }
    setError(null);
    try {
      const owner = requireAuthSessionSnapshot();
      setBusy('Creating campaign…');
      const created = await adsApi.createCampaign({
        advertiserId: advertiser.id,
        placementId: placement.id,
        name: name.trim() || `${advertiser.companyName} — ${placement.name}`,
        cities,
        startWeek: range.startWeek,
        endWeek: range.endWeek,
        ...(destinationValue.trim() ? { destinationType: 'URL' as const, destinationValue: destinationValue.trim() } : {}),
      }, owner);
      let current = requireAuthSessionForPrincipal(owner);
      const campaign = created.data?.data;
      if (!campaign?.id) throw new Error('Campaign creation did not return an id');

      if (asset) {
        setBusy('Uploading creative…');
        const form = new FormData();
        form.append('kind', placement.mediaKind);
        if (headline.trim()) form.append('headline', headline.trim());
        if (ctaLabel.trim()) form.append('ctaLabel', ctaLabel.trim());
        form.append('file', { uri: asset.uri, type: asset.mime, name: asset.name } as unknown as Blob);
        await adsApi.uploadCreative(campaign.id, form, current);
        current = requireAuthSessionForPrincipal(owner);
      }

      // Gated preview (§14.1): an unapproved advertiser stops at the draft —
      // the server would reject reserve anyway; the UI mirrors the lock.
      if (!approved) {
        requireAuthSessionForPrincipal(owner);
        void queryClient.invalidateQueries({ queryKey: ['ads'] });
        navigation.replace('CampaignDetail', { campaignId: campaign.id });
        return;
      }

      setBusy('Reserving your weeks…');
      await adsApi.reserve(campaign.id, current);
      current = requireAuthSessionForPrincipal(owner);

      setBusy('Issuing invoice…');
      const checkoutResponse = await adsApi.checkout(campaign.id, 'MANUAL', current);
      requireAuthSessionForPrincipal(owner);
      const checkout = checkoutResponse.data?.data;
      void queryClient.invalidateQueries({ queryKey: ['ads'] });
      setCheckoutResult({ ...checkout, campaignId: campaign.id });
    } catch (e) {
      if (!(e instanceof AuthSessionBoundaryError)) {
        setError(errorMessage(e, 'Something failed — your draft is preserved.'));
      }
    } finally {
      setBusy(null);
    }
  };

  if (checkoutResult) {
    return (
      <View style={{ flex: 1, backgroundColor: color.surface.subtle, paddingTop: insets.top }}>
        <ScrollView contentContainerStyle={{ padding: space['2xl'] }}>
          <Feather name="check-circle" size={44} color={color.success} />
          <T variant="title" style={{ marginTop: space.lg }}>
            Slots held — invoice {checkoutResult.number}
          </T>
          <Card style={{ padding: space.xl, marginTop: space['2xl'], gap: space.sm }}>
            <T variant="body" weight="semibold">
              {money(checkoutResult.amount, checkoutResult.currency)}
            </T>
            <T variant="caption" tone="muted">
              Your weeks are reserved until {new Date(checkoutResult.reservedUntil).toLocaleTimeString()} — complete
              payment before then or the hold releases automatically.
            </T>
            <T variant="caption" tone="muted">
              Pay via MMG or bank transfer and the operator confirms receipt; your campaign then enters creative
              review and goes live automatically at your start week.
            </T>
          </Card>
          <PillButton
            label="Open campaign"
            style={{ marginTop: space['2xl'] }}
            onPress={() => navigation.replace('CampaignDetail', { campaignId: checkoutResult.campaignId })}
          />
        </ScrollView>
      </View>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: color.surface.subtle, paddingTop: insets.top }}>
      {/* Header + step dots */}
      <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: space.xl, paddingVertical: space.md }}>
        <Pressable onPress={() => (step === 1 ? navigation.goBack() : setStep((s) => (s === 5 ? 4 : s === 4 ? 2 : 1) as Step))} hitSlop={10}>
          <Feather name="arrow-left" size={22} color={color.text.primary} />
        </Pressable>
        <T variant="heading" style={{ marginLeft: space.lg, flex: 1 }}>
          New campaign
        </T>
        <T variant="caption" tone="muted">
          {step === 1 ? '1' : step === 2 ? '2' : step === 4 ? '3' : '4'} / 4
        </T>
      </View>

      <ScrollView contentContainerStyle={{ padding: space['2xl'], paddingBottom: space['3xl'] }} keyboardShouldPersistTaps="handled">
        {step === 1 ? (
          <>
            <T variant="body" tone="muted">
              Where should your ad appear? Flat weekly price — no auctions.
            </T>
            {placements.isLoading ? (
              <LoadingBlock style={{ paddingTop: 64 }} />
            ) : (
              <View style={{ marginTop: space.xl, gap: space.lg }}>
                {(placements.data ?? []).map((p: any) => {
                  const selected = placement?.id === p.id;
                  return (
                    <Pressable key={p.id} onPress={() => setPlacement(p)}>
                      <Card style={{ padding: space.xl, borderWidth: 2, borderColor: selected ? color.brand[500] : 'transparent' }}>
                        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                          <T variant="body" weight="semibold">
                            {p.name}
                          </T>
                          {/* [law 3] Money is ink, never brand — maroon marks
                              the selected card's border, not the price. */}
                          <T variant="label" weight="semibold">
                            {money(p.weeklyPrice, p.currency)}/wk
                          </T>
                        </View>
                        <T variant="caption" tone="muted" style={{ marginTop: 4 }}>
                          {p.mediaKind === 'VIDEO' ? 'Autoplay video at the top of home' : p.tier === 2 ? 'Large card in the home feed' : `Rotating bar — ${p.slotsPerWeek} slots, one is yours`}
                        </T>
                      </Card>
                    </Pressable>
                  );
                })}
              </View>
            )}
            {/* [#947's grammar] Step 2's button already names its ask —
                step 1's now does the same. */}
            <PillButton label={placement ? 'Choose weeks' : 'Pick a placement first'} disabled={!placement} style={{ marginTop: space['2xl'] }} onPress={() => setStep(2)} />
          </>
        ) : null}

        {step === 2 ? (
          <>
            <T variant="body" tone="muted">
              Pick the Mondays you want. Sold-out weeks are greyed.
            </T>
            {availability.isLoading ? (
              <LoadingBlock style={{ paddingTop: 64 }} />
            ) : (
              <View style={{ marginTop: space.xl, gap: space.md }}>
                {((availability.data ?? []) as any[]).map((w) => {
                  const iso = String(w.weekStart).slice(0, 10);
                  const soldOut = (w.available ?? 0) <= 0;
                  const selected = weeks.includes(iso);
                  return (
                    <Pressable key={iso} onPress={() => onToggleWeek(iso)} disabled={soldOut}>
                      <Card
                        style={{
                          padding: space.lg,
                          opacity: soldOut ? 0.45 : 1,
                          borderWidth: 2,
                          borderColor: selected ? color.brand[500] : 'transparent',
                          flexDirection: 'row',
                          justifyContent: 'space-between',
                          alignItems: 'center',
                        }}
                      >
                        <T variant="body">Week of {iso}</T>
                        <T variant="caption" tone="muted">
                          {soldOut ? 'Sold out' : `${w.available} of ${w.capacity} open`}
                        </T>
                      </Card>
                    </Pressable>
                  );
                })}
              </View>
            )}
            {weekNotice ? (
              <T variant="caption" tone="muted" style={{ marginTop: space.lg }}>{weekNotice}</T>
            ) : null}
            <PillButton label={weeks.length ? `Continue — ${weeks.length} week${weeks.length > 1 ? 's' : ''}` : 'Pick at least one week'} disabled={weeks.length === 0} style={{ marginTop: space['2xl'] }} onPress={() => setStep(4)} />
          </>
        ) : null}

        {step === 4 ? (
          <>
            {/* §9.1 spec card BEFORE the picker opens. */}
            <Card style={{ padding: space.xl, backgroundColor: color.brand[50] }}>
              <T variant="label" weight="semibold">
                Creative specs — {placement?.mediaKind === 'VIDEO' ? 'MP4 video' : 'image'}
              </T>
              <T variant="caption" tone="muted" style={{ marginTop: 4 }}>
                {placement?.mediaKind === 'VIDEO'
                  ? 'MP4 (H.264 + AAC), up to 25 MB. Reviewed before going live.'
                  : 'JPEG, PNG or WebP up to 500 KB. Reviewed before going live.'}
                {'\n'}Headline ≤{placement?.tier === 1 ? 60 : 40} chars · CTA ≤15 chars. The "Ad · {advertiser?.companyName ?? 'you'}" label is added by Swift.
              </T>
            </Card>

            {placement?.mediaKind === 'VIDEO' ? (
              <Card style={{ padding: space.xl, marginTop: space.lg }}>
                <T variant="caption" tone="muted">
                  Video upload from a phone gallery lands in the transcode queue. You can also add the video later
                  from the campaign screen — your booking is not affected.
                </T>
              </Card>
            ) : (
              <Pressable onPress={pickImage} style={{ marginTop: space.lg }}>
                <Card style={{ padding: space.xl, alignItems: 'center', justifyContent: 'center', minHeight: 140 }}>
                  {asset ? (
                    <Image source={{ uri: asset.uri }} style={{ width: '100%', height: 120, borderRadius: radius.md }} resizeMode="cover" />
                  ) : (
                    <>
                      <Feather name="image" size={28} color={color.text.muted} />
                      <T variant="label" tone="muted" style={{ marginTop: space.sm }}>
                        Tap to choose your image
                      </T>
                    </>
                  )}
                </Card>
              </Pressable>
            )}

            <View style={{ marginTop: space.lg, gap: space.lg }}>
              <LabeledInput label="Campaign name" value={name} onChangeText={setName} placeholder={`${advertiser?.companyName ?? 'My'} — ${placement?.name ?? 'campaign'}`} />
              <LabeledInput label="Headline" value={headline} onChangeText={setHeadline} maxLength={placement?.tier === 1 ? 60 : 40} placeholder="Fresh roti, hot daily" />
              <LabeledInput label="Button label (optional)" value={ctaLabel} onChangeText={setCtaLabel} maxLength={15} placeholder="Order now" />
              <LabeledInput label="Link (optional)" value={destinationValue} onChangeText={setDestinationValue} autoCapitalize="none" placeholder="https://your-site.gy" />
            </View>
            <PillButton label="Review order" style={{ marginTop: space['2xl'] }} onPress={() => setStep(5)} />
          </>
        ) : null}

        {step === 5 ? (
          <>
            <Card style={{ padding: space.xl, gap: space.sm }}>
              <T variant="heading">{name.trim() || `${advertiser?.companyName ?? ''} — ${placement?.name ?? ''}`}</T>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                <T variant="body" tone="muted">
                  {placement?.name}
                </T>
                <T variant="body">{money(placement?.weeklyPrice)}/wk</T>
              </View>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                <T variant="body" tone="muted">
                  {weeks.length} week{weeks.length > 1 ? 's' : ''} ({weeks[0]} → {weeks[weeks.length - 1]})
                </T>
                <T variant="body">× {weeks.length}</T>
              </View>
              <View style={{ height: 1, backgroundColor: color.border.subtle, marginVertical: space.sm }} />
              <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                <T variant="body" weight="semibold">
                  Total
                </T>
                <T variant="body" weight="semibold">
                  {money(total)}
                </T>
              </View>
            </Card>

            <Card style={{ padding: space.xl, marginTop: space.lg }}>
              <T variant="caption" tone="muted">
                Refunds: full refund if your creatives are never approved; cancel ≥7 days before a week starts for
                100%, later for 50%; started weeks are not refunded. Cancelling always shows the exact amount first.
              </T>
            </Card>

            {!approved ? (
              <Card style={{ padding: space.xl, marginTop: space.lg, borderLeftWidth: 3, borderLeftColor: color.warning }}>
                <T variant="caption">
                  Your advertiser account is still in review — payment unlocks the moment you're approved. Your draft
                  is saved.
                </T>
              </Card>
            ) : null}

            {error ? (
              <T variant="label" style={{ color: color.error, marginTop: space.lg }}>
                {error}
              </T>
            ) : null}

            <PillButton
              label={busy ?? (approved ? `Reserve & get invoice — ${money(total)}` : 'Save draft')}
              loading={!!busy}
              disabled={weeks.length === 0}
              style={{ marginTop: space['2xl'] }}
              onPress={reserveAndPay}
            />
          </>
        ) : null}
      </ScrollView>
    </View>
  );
}
