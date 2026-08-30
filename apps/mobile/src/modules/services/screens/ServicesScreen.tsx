/** @jsxImportSource react */
import React, { useState } from 'react';
import { ScrollView, StyleSheet, TextInput, View } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { color, font, fontSize, radius, space } from '@swift/ui';
import { useServiceProviders, useRequestJob } from '../../../hooks';
import { Card, Chip, DecorativeIcon, EmptyState, Header, IconChip, LinkText, LoadingBlock, Pictogram, PillButton, PopupCard, PopupTitle, RatingMeta, Screen, T, TonePill, type PictogramName } from '../../../kit';
import { VERTICAL_TINT } from '../../../kit/vertical-tint';
import { useAuthStore } from '../../../stores/authStore';
import { enterServiceProvider } from '../serviceProviderEntry';

type TradeOption = { key: string; label: string; pictogram: PictogramName };

const SERVICES_TINT = VERTICAL_TINT.services ?? { bg: color.brand[50], ink: color.brand[600] };

const TRADES: TradeOption[] = [
  { key: 'electrician', label: 'Electrician', pictogram: 'electrician' },
  { key: 'plumber', label: 'Plumber', pictogram: 'plumber' },
  { key: 'carpenter', label: 'Carpenter', pictogram: 'carpenter' },
  { key: 'cleaner', label: 'Cleaner', pictogram: 'services' },
  { key: 'ac_refrigeration', label: 'AC repair', pictogram: 'ac-fridge' },
  { key: 'mechanic', label: 'Mechanic', pictogram: 'services' },
  { key: 'painter', label: 'Painter', pictogram: 'painter' },
  { key: 'mason', label: 'Mason', pictogram: 'mason' },
  { key: 'welder', label: 'Welder', pictogram: 'services' },
  { key: 'gardener', label: 'Gardener', pictogram: 'services' },
];

type ServiceProvider = {
  id: string;
  trade: string;
  tradeLabel: string;
  bio: string | null;
  portfolioPhotos: string[];
  // The one mapper's star line. `displayRating` is null below
  // RATING_MIN_DISPLAY — render THIS, never `averageRating` (see the card).
  displayRating: number | null;
  ratingBucket?: string;
  averageRating: number;
  totalRatings: number;
  selfSkilled: boolean;
  certified: boolean;
  badges: string[];
};

type ProviderBrowse = {
  guidance?: string;
  riskTier?: 'HIGH' | 'LOW';
  providers?: ServiceProvider[];
};

export function ServicesScreen({ navigation }: any) {
  const isAuthenticated = useAuthStore((state) => state.isAuthenticated);
  const promptLogin = useAuthStore((state) => state.promptLogin);
  const [trade, setTrade] = useState<string | undefined>(undefined);
  const [selectedProviderId, setSelectedProviderId] = useState<string | undefined>(undefined);
  const [description, setDescription] = useState('');
  const [sentPopup, setSentPopup] = useState(false);

  const { data, isFetching, isError } = useServiceProviders<ProviderBrowse>(trade);
  const requestJob = useRequestJob();

  const providers = data?.providers ?? [];
  const selectedTrade = TRADES.find((option) => option.key === trade);
  const canSend = !!selectedProviderId && description.trim().length >= 10;
  const errMsg = (requestJob.error as any)?.response?.data?.message;

  const onSend = () => {
    if (!selectedProviderId || description.trim().length < 10) return;
    requestJob.mutate(
      { providerId: selectedProviderId, description: description.trim() },
      {
        onSuccess: () => {
          setSentPopup(true);
          setSelectedProviderId(undefined);
          setDescription('');
        },
      },
    );
  };

  return (
    <Screen>
      <Header title="Services" right={<LinkText label="My jobs" onPress={() => navigation?.navigate?.('ServiceJobs')} />} />
      <ScrollView
        contentContainerStyle={{ paddingHorizontal: space['2xl'], paddingTop: space.sm, paddingBottom: selectedProviderId ? space['5xl'] * 5 + space.xl : space['3xl'] }}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >
        <T variant="title">Hire a pro</T>
        <T variant="body" tone="muted" style={{ marginTop: space.sm, marginBottom: space.lg }}>
          Verified tradespeople. Discuss the quote in chat, then pay cash on completion.
        </T>

        <Card style={{ flexDirection: 'row', alignItems: 'center', gap: space.md, marginBottom: space.xl }}>
          <IconChip icon="briefcase" />
          <View style={{ flex: 1 }}>
            <T variant="label" weight="semibold">Offer your own services</T>
            <T variant="caption" tone="muted" style={{ marginTop: space.xs }}>
              Set up your profile, verification, and provider jobs.
            </T>
          </View>
          <PillButton
            label="Open"
            variant="soft"
            size="md"
            onPress={() => enterServiceProvider({
              isAuthenticated,
              promptLogin,
              navigate: (screen) => navigation?.navigate?.(screen),
            })}
          />
        </Card>

        <T variant="heading" style={{ marginBottom: space.sm }}>
          Choose a trade
        </T>
        <T variant="caption" tone="muted" style={{ marginBottom: space.md }}>
          Pick the work first, then compare verified providers.
        </T>
        {/* [Wave 3 · ref 13] The reference draws trade PILLS — the kit Chip —
            not pictogram tiles. Tiles were an unrecorded invention; the
            reference outranks them. */}
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm }}>
          {TRADES.map((option) => (
            <Chip
              key={option.key}
              label={option.label}
              selected={option.key === trade}
              onPress={() => {
                setTrade(option.key);
                setSelectedProviderId(undefined);
              }}
            />
          ))}
        </View>

        {/* Safety guidance from the API (licensed-trade nudges) */}
        {trade && data?.guidance ? (
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'flex-start',
              gap: space.md,
              marginTop: space.xl,
              padding: space.lg,
              borderRadius: radius.lg,
              backgroundColor: data.riskTier === 'HIGH' ? color.soft.warning : color.soft.info,
            }}
          >
            <Feather name="shield" size={20} color={data.riskTier === 'HIGH' ? color.warning : color.info} />
            <T variant="label" tone={data.riskTier === 'HIGH' ? 'warning' : 'info'} style={{ flex: 1 }}>
              {data.guidance}
            </T>
          </View>
        ) : null}

        {!trade ? (
          <EmptyState icon="tool" title="What needs doing?" body="Pick a service to see verified pros near you." />
        ) : isFetching ? (
          <LoadingBlock />
        ) : isError ? (
          <EmptyState icon="alert-circle" title="Couldn’t load providers" body="Give it another go in a moment." />
        ) : providers.length === 0 ? (
          <EmptyState
            icon="users"
            title="None available yet"
            body={`No ${selectedTrade?.label.toLowerCase() ?? 'service'} providers near you yet — check back soon.`}
          />
        ) : (
          <View style={{ marginTop: space.xl, gap: space.md }}>
            {providers.map((p) => {
              const selected = p.id === selectedProviderId;
              const providerPictogram = TRADES.find((option) => option.key === p.trade)?.pictogram ?? 'services';
              return (
                <Card
                  key={p.id}
                  style={selected ? { borderWidth: space.xs / 2, borderColor: SERVICES_TINT.ink } : undefined}
                >
                  <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: space.md }}>
                    <View
                      accessible={false}
                      accessibilityElementsHidden
                      importantForAccessibility="no-hide-descendants"
                      style={{
                        width: space['5xl'],
                        height: space['5xl'],
                        borderRadius: radius.md,
                        backgroundColor: SERVICES_TINT.bg,
                        alignItems: 'center',
                        justifyContent: 'center',
                      }}
                    >
                      <Pictogram name={providerPictogram} size={space['2xl']} color={SERVICES_TINT.ink} />
                    </View>
                    <View style={{ flex: 1 }}>
                      <View style={{ flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: space.sm }}>
                        <T variant="heading" style={{ flexShrink: 1 }}>
                          {p.tradeLabel}
                        </T>
                        <TonePill label="Verified" tone="success" />
                      </View>
                      <View style={{ marginTop: space.sm }}>
                        {/* [ALG-31 / L2] `displayRating` from the one mapper.
                            This read the raw mean behind a hand-rolled
                            `totalRatings > 0` threshold — a THIRD definition of
                            when a rating may be shown, and a far looser one than
                            RATING_MIN_DISPLAY (5). A tradesperson with a single
                            1-star rating was branded ★1.0 on the browse page,
                            which is exactly what the threshold exists to
                            prevent. The count stays honest and separate. */}
                        <RatingMeta
                          rating={p.displayRating ?? null}
                          extra={p.totalRatings > 0 ? `${p.totalRatings} ratings` : undefined}
                        />
                      </View>
                      <View style={{ marginTop: space.sm }}>
                        {p.certified ? (
                          <TonePill label="Certified qualification" tone="neutral" />
                        ) : (
                          <T variant="caption" tone="muted">
                            {p.selfSkilled ? 'Self-skilled' : 'No trade credential shown'}
                          </T>
                        )}
                      </View>
                    </View>
                    {/* [ref 13] The button sits compact in the card's top
                        row — "Request", or the filled "Selected" (tap again
                        to unpick). The per-card "discuss quotes" box is gone:
                        the page subtitle says it once for everyone. */}
                    <PillButton
                      label={selected ? 'Selected' : 'Request'}
                      variant={selected ? 'primary' : 'soft'}
                      size="sm"
                      onPress={() => setSelectedProviderId(selected ? undefined : p.id)}
                    />
                  </View>
                  {p.bio ? (
                    <T variant="label" tone="muted" numberOfLines={2} style={{ marginTop: space.md }}>
                      {p.bio}
                    </T>
                  ) : null}
                </Card>
              );
            })}
          </View>
        )}
      </ScrollView>

      {/* Job composer — slides in when a provider is chosen */}
      {selectedProviderId ? (
        <View
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            bottom: 0,
            backgroundColor: color.surface.base,
            borderTopWidth: StyleSheet.hairlineWidth,
            borderTopColor: color.border.subtle,
            paddingHorizontal: space['2xl'],
            paddingTop: space.lg,
            paddingBottom: space['2xl'],
            gap: space.md,
          }}
        >
          <View
            style={{
              borderRadius: radius.lg,
              borderWidth: StyleSheet.hairlineWidth,
              borderColor: color.border.subtle,
              backgroundColor: color.surface.base,
              paddingHorizontal: space.lg,
              paddingVertical: space.md,
              minHeight: space['5xl'] + space['2xl'],
            }}
          >
            <TextInput
              value={description}
              onChangeText={setDescription}
              placeholder="Describe the job (at least 10 characters)…"
              placeholderTextColor={color.text.muted}
              multiline
              style={{ fontFamily: font.body, fontSize: fontSize.base, color: color.text.primary, minHeight: space['5xl'] }}
            />
          </View>
          {errMsg ? (
            <T variant="label" tone="error" center>
              {errMsg}
            </T>
          ) : null}
          <PillButton label="Send request" loading={requestJob.isPending} disabled={!canSend} onPress={onSend} />
        </View>
      ) : null}

      {/* Kit success popup */}
      <PopupCard visible={sentPopup} onClose={() => setSentPopup(false)}>
        <DecorativeIcon
          style={{
            width: space['5xl'] + space['2xl'],
            height: space['5xl'] + space['2xl'],
            borderRadius: radius.full,
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: color.brand[500],
          }}
        >
          <Feather name="check" size={space['3xl']} color={color.white} />
        </DecorativeIcon>
        <PopupTitle variant="title" center style={{ marginTop: space.lg }}>
          Request sent
        </PopupTitle>
        <T variant="body" tone="muted" center style={{ marginTop: space.sm }}>
          The quote lands in My jobs — accept it there and pick a time. Pay cash on completion.
        </T>
        <PillButton
          label="View my jobs"
          style={{ alignSelf: 'stretch', marginTop: space['2xl'] }}
          onPress={() => {
            setSentPopup(false);
            navigation?.navigate?.('ServiceJobs');
          }}
        />
        <PillButton label="Done" variant="soft" style={{ alignSelf: 'stretch', marginTop: space.md }} onPress={() => setSentPopup(false)} />
      </PopupCard>
    </Screen>
  );
}
