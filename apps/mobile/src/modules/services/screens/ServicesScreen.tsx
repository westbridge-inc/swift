/** @jsxImportSource react */
import React, { useState } from 'react';
import { ScrollView, TextInput, View } from 'react-native';
import { Feather, MaterialCommunityIcons } from '@expo/vector-icons';
import { color, radius, space } from '@swift/ui';
import { useServiceProviders, useRequestJob } from '../../../hooks';
import { Card, Chip, EmptyState, Header, IconChip, LinkText, LoadingBlock, PillButton, PopupCard, RatingMeta, Screen, T, TonePill } from '../../../kit';

const TRADES = [
  'Electrician',
  'Plumber',
  'Carpenter',
  'Cleaner',
  'AC Repair',
  'Mechanic',
  'Painter',
  'Mason',
  'Welder',
  'Gardener',
];

export function ServicesScreen({ navigation }: any) {
  const [trade, setTrade] = useState<string | undefined>(undefined);
  const [selectedProviderId, setSelectedProviderId] = useState<string | undefined>(undefined);
  const [description, setDescription] = useState('');
  const [sentPopup, setSentPopup] = useState(false);

  const { data, isFetching, isError } = useServiceProviders<any>(trade);
  const requestJob = useRequestJob();

  const providers: any[] = data?.providers ?? [];
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
        contentContainerStyle={{ paddingHorizontal: space['2xl'], paddingTop: space.sm, paddingBottom: selectedProviderId ? 260 : space['3xl'] }}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >
        <T variant="title">Hire a pro</T>
        <T variant="body" tone="muted" style={{ marginTop: space.sm, marginBottom: space.lg }}>
          Verified tradespeople. Quote in chat, pay cash on completion.
        </T>

        {/* Trade chips */}
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.md }}>
          {TRADES.map((t) => (
            <Chip
              key={t}
              label={t}
              selected={t === trade}
              onPress={() => {
                setTrade(t);
                setSelectedProviderId(undefined);
              }}
              style={{ height: 40, paddingHorizontal: space.lg }}
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
              backgroundColor: color.brand[50],
            }}
          >
            <MaterialCommunityIcons name="shield-check" size={20} color={color.brand[600]} />
            <T variant="label" tone="deep" style={{ flex: 1 }}>
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
            body={`No ${trade.toLowerCase()}s near you yet — check back soon.`}
          />
        ) : (
          <View style={{ marginTop: space.xl, gap: space.md }}>
            {providers.map((p) => {
              const selected = p.id === selectedProviderId;
              return (
                <Card key={p.id} style={selected ? { borderWidth: 1, borderColor: color.brand[500] } : undefined}>
                  <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: space.md }}>
                    <IconChip icon="tool" />
                    <View style={{ flex: 1 }}>
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
                        <T variant="body" weight="semibold" style={{ flexShrink: 1 }}>
                          {p.certified ? `Certified ${p.trade}` : p.trade}
                        </T>
                        {p.certified ? <TonePill label="Licensed" tone="success" /> : null}
                      </View>
                      {p.totalRatings > 0 ? (
                        <View style={{ marginTop: 4 }}>
                          <RatingMeta rating={Number(p.averageRating)} extra={`${p.totalRatings} ratings`} />
                        </View>
                      ) : (
                        <T variant="caption" tone="muted" style={{ marginTop: 4 }}>
                          New{p.selfSkilled ? ' · Self-skilled' : ''}
                        </T>
                      )}
                      {p.bio ? (
                        <T variant="label" tone="muted" numberOfLines={2} style={{ marginTop: 4 }}>
                          {p.bio}
                        </T>
                      ) : null}
                    </View>
                    <PillButton
                      label={selected ? 'Selected' : 'Request'}
                      variant={selected ? 'primary' : 'soft'}
                      size="sm"
                      onPress={() => setSelectedProviderId(selected ? undefined : p.id)}
                    />
                  </View>
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
            borderTopWidth: 1,
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
              borderWidth: 1,
              borderColor: color.border.subtle,
              backgroundColor: color.surface.base,
              paddingHorizontal: space.lg,
              paddingVertical: space.md,
              minHeight: 72,
            }}
          >
            <TextInput
              value={description}
              onChangeText={setDescription}
              placeholder="Describe the job (at least 10 characters)…"
              placeholderTextColor={color.text.muted}
              multiline
              style={{ fontFamily: 'Inter', fontSize: 15, color: color.text.primary, minHeight: 48 }}
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
        <View
          style={{
            width: 72,
            height: 72,
            borderRadius: 36,
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: color.brand[500],
          }}
        >
          <Feather name="check" size={34} color={color.white} />
        </View>
        <T variant="title" center style={{ marginTop: space.lg }}>
          Request sent
        </T>
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
