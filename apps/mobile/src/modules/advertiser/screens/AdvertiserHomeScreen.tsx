/** @jsxImportSource react */
import React from 'react';
import { Pressable, RefreshControl, ScrollView, View } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { color, radius, space } from '@swift/ui';
import { Card, EmptyState, LoadingBlock, PillButton, T, TonePill } from '../../../kit';
import { useMyAdvertisers, useAdvertiserCampaigns } from '../../../hooks/advertiser';

// §14.1/§14.2 — onboarding status banner (gated-preview pattern) + the
// campaign list. Statuses speak human (§6.1 states, human-worded).

export const CAMPAIGN_STATUS: Record<string, { label: string; tone: 'brand' | 'success' | 'neutral' | 'error' }> = {
  DRAFT: { label: 'Draft', tone: 'neutral' },
  PENDING_PAYMENT: { label: 'Awaiting payment', tone: 'brand' },
  PENDING_REVIEW: { label: 'In review', tone: 'brand' },
  SCHEDULED: { label: 'Scheduled', tone: 'success' },
  LIVE: { label: 'Live', tone: 'success' },
  PAUSED: { label: 'Paused', tone: 'neutral' },
  COMPLETED: { label: 'Completed', tone: 'neutral' },
  CANCELLED: { label: 'Cancelled', tone: 'error' },
  REJECTED: { label: 'Not approved', tone: 'error' },
};

export function money(n: number | null | undefined, currency = 'GYD'): string {
  if (n == null) return '—';
  return `${currency === 'GYD' ? 'G$' : currency} ${Math.round(n).toLocaleString('en-US')}`;
}

export function AdvertiserHomeScreen() {
  const navigation = useNavigation<any>();
  const insets = useSafeAreaInsets();
  const me = useMyAdvertisers();
  const advertiser = (me.data ?? [])[0];
  const campaigns = useAdvertiserCampaigns(advertiser?.id);
  const approved = advertiser?.status === 'APPROVED';

  const rows = campaigns.data ?? [];

  return (
    <View style={{ flex: 1, backgroundColor: color.surface.subtle }}>
      <View style={{ backgroundColor: color.brand[500], paddingTop: insets.top + space.sm, paddingBottom: space.xl, paddingHorizontal: space['2xl'] }}>
        <T variant="title" style={{ color: '#FFFFFF' }}>
          {advertiser?.companyName ?? 'Your ads'}
        </T>
        <T variant="caption" style={{ color: 'rgba(255,255,255,0.85)', marginTop: 2 }}>
          Home-screen advertising · flat weekly rates
        </T>
      </View>

      <ScrollView
        contentContainerStyle={{ padding: space['2xl'], paddingBottom: space['3xl'] }}
        refreshControl={<RefreshControl refreshing={campaigns.isRefetching} onRefresh={() => campaigns.refetch()} tintColor={color.brand[500]} />}
      >
        {/* §14.1 status banner — the gated-preview truth-teller. */}
        {advertiser && advertiser.status !== 'APPROVED' ? (
          <Card style={{ padding: space.xl, marginBottom: space['2xl'], borderLeftWidth: 3, borderLeftColor: advertiser.status === 'PENDING_REVIEW' ? color.warning : color.error }}>
            <T variant="body" weight="semibold">
              {advertiser.status === 'PENDING_REVIEW' && 'Your application is being reviewed'}
              {advertiser.status === 'REJECTED' && 'Your application was not approved'}
              {advertiser.status === 'SUSPENDED' && 'Your account is suspended'}
            </T>
            <T variant="caption" tone="muted" style={{ marginTop: 4 }}>
              {advertiser.status === 'PENDING_REVIEW' &&
                'You can explore and draft campaigns now. Booking and payment unlock the moment you are approved — usually within a day.'}
              {advertiser.status === 'REJECTED' && 'Your drafts are preserved. Contact support to appeal.'}
              {advertiser.status === 'SUSPENDED' && 'Your live campaigns are paused. Contact support.'}
            </T>
          </Card>
        ) : null}

        <PillButton label="New campaign" icon="plus" onPress={() => navigation.navigate('NewCampaign')} />

        {campaigns.isLoading ? (
          <LoadingBlock style={{ paddingTop: 64 }} />
        ) : rows.length === 0 ? (
          <EmptyState
            icon="tv"
            title="No campaigns yet"
            body={approved ? 'Book your first week on the Swift home screen.' : 'Draft a campaign now — it goes live once you are approved and paid.'}
            style={{ paddingTop: 48 }}
          />
        ) : (
          <View style={{ marginTop: space['2xl'], gap: space.lg }}>
            {rows.map((c: any) => {
              const s = CAMPAIGN_STATUS[c.status] ?? { label: c.status, tone: 'neutral' as const };
              return (
                <Pressable key={c.id} onPress={() => navigation.navigate('CampaignDetail', { campaignId: c.id })}>
                  {({ pressed }) => (
                    <Card style={{ padding: space.xl, opacity: pressed ? 0.9 : 1 }}>
                      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                        <T variant="body" weight="semibold" numberOfLines={1} style={{ flex: 1, marginRight: space.md }}>
                          {c.name}
                        </T>
                        <TonePill label={s.label} tone={s.tone} />
                      </View>
                      <T variant="caption" tone="muted" style={{ marginTop: 4 }}>
                        {c.placement.name} · week of {String(c.startWeek).slice(0, 10)}
                        {String(c.endWeek).slice(0, 10) !== String(c.startWeek).slice(0, 10) ? ` → ${String(c.endWeek).slice(0, 10)}` : ''}
                      </T>
                      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: space.md }}>
                        <T variant="label" weight="semibold">
                          {money(c.totalAmount, c.currency)}
                        </T>
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                          <Feather name="chevron-right" size={16} color={color.text.muted} />
                        </View>
                      </View>
                      {c.status === 'PENDING_PAYMENT' && c.invoices?.[0] ? (
                        <View style={{ marginTop: space.md, backgroundColor: color.brand[50], borderRadius: radius.md, padding: space.md }}>
                          <T variant="caption">
                            Invoice {c.invoices[0].number} awaits payment — open the campaign to finish checkout.
                          </T>
                        </View>
                      ) : null}
                    </Card>
                  )}
                </Pressable>
              );
            })}
          </View>
        )}
      </ScrollView>
    </View>
  );
}
