/** @jsxImportSource react */
import React, { useState } from 'react';
import { Alert, RefreshControl, ScrollView, View } from 'react-native';
import { useRoute, useNavigation } from '@react-navigation/native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { Pressable } from 'react-native';
import { color, radius, space } from '@swift/ui';
import { ErrorState, Card, LoadingBlock, PillButton, T, TonePill } from '../../../kit';
import { useMyAdvertisers, useAdvertiserCampaigns, useCampaignStats, useAdvertiserActions } from '../../../hooks/advertiser';
import { adsApi } from '../../../services/api';
import { errorMessage } from '../../../lib/apiError';
import { CAMPAIGN_STATUS } from './AdvertiserHomeScreen';
import { moneyOrDash as money } from '../../../lib/money';
import {
  AuthSessionBoundaryError,
  requireAuthSessionForPrincipal,
  requireAuthSessionSnapshot,
} from '../../../stores/authStore';

// §14.4 — campaign detail: human-worded §6.1 status timeline, §12.3 stats
// from the rollups, creatives with review status, pause/resume/cancel. THE
// law here: cancel first fetches the server's refund preview and shows the
// EXACT amount before asking for confirmation — the same pure calculator the
// cancel executes.

const TIMELINE: Array<{ key: string; label: string }> = [
  { key: 'DRAFT', label: 'Drafted' },
  { key: 'PENDING_PAYMENT', label: 'Invoice issued' },
  { key: 'PENDING_REVIEW', label: 'Paid — creatives in review' },
  { key: 'SCHEDULED', label: 'Approved — scheduled' },
  { key: 'LIVE', label: 'Live on home screens' },
  { key: 'COMPLETED', label: 'Completed' },
];
const ORDER: Record<string, number> = Object.fromEntries(TIMELINE.map((t, i) => [t.key, i]));

function StatCell({ label, value }: { label: string; value: string }) {
  return (
    <View style={{ flex: 1, alignItems: 'center' }}>
      <T variant="heading">{value}</T>
      <T variant="caption" tone="muted">
        {label}
      </T>
    </View>
  );
}

export function CampaignDetailScreen() {
  const route = useRoute<any>();
  const navigation = useNavigation<any>();
  const insets = useSafeAreaInsets();
  const campaignId: string = route.params?.campaignId;

  const me = useMyAdvertisers();
  const advertiser = (me.data ?? [])[0];
  const campaigns = useAdvertiserCampaigns(advertiser?.id);
  const campaign = (campaigns.data ?? []).find((c: any) => c.id === campaignId);
  const stats = useCampaignStats(campaignId);
  const actions = useAdvertiserActions(advertiser?.id);
  const [acting, setActing] = useState(false);

  const s = campaign ? (CAMPAIGN_STATUS[campaign.status] ?? { label: campaign.status, tone: 'neutral' as const }) : null;
  const pos = campaign ? (ORDER[campaign.status] ?? -1) : -1;
  const terminal = campaign && ['COMPLETED', 'CANCELLED', 'REJECTED'].includes(campaign.status);

  /** The §14.4 cancel: preview first, confirm with the exact figure. */
  const confirmCancel = async () => {
    if (!campaign) return;
    setActing(true);
    try {
      const owner = requireAuthSessionSnapshot();
      const res = await adsApi.refundPreview(campaign.id, owner);
      requireAuthSessionForPrincipal(owner);
      const plan = res?.data?.data as { total: number; items: Array<{ kind: string }> };
      const refundTotal = plan?.total ?? 0;
      Alert.alert(
        'Cancel this campaign?',
        refundTotal > 0
          ? `You will get back ${money(refundTotal, campaign.currency)} per the refund policy. This cannot be undone.`
          : 'No refund is due for the remaining weeks (already-started weeks are not refunded). This cannot be undone.',
        [
          { text: 'Keep campaign', style: 'cancel' },
          {
            text: refundTotal > 0 ? `Cancel — refund ${money(refundTotal, campaign.currency)}` : 'Cancel campaign',
            style: 'destructive',
            onPress: () => {
              void (async () => {
                setActing(true);
                try {
                  const current = requireAuthSessionForPrincipal(owner);
                  await adsApi.cancel(campaign.id, current);
                  requireAuthSessionForPrincipal(owner);
                  await Promise.all([campaigns.refetch(), stats.refetch()]);
                  requireAuthSessionForPrincipal(owner);
                } catch (cancelError) {
                  if (!(cancelError instanceof AuthSessionBoundaryError)) {
                    Alert.alert('Could not cancel', errorMessage(cancelError));
                  }
                } finally {
                  setActing(false);
                }
              })();
            },
          },
        ],
      );
    } catch (e) {
      if (!(e instanceof AuthSessionBoundaryError)) {
        Alert.alert('Could not load refund preview', errorMessage(e));
      }
    } finally {
      setActing(false);
    }
  };

  if (!campaign) {
    // [WR-031] A failed load spun forever; only a genuine in-flight fetch may.
    const failed = (me.isError || campaigns.isError) && !campaigns.isFetching;
    const loadedButMissing = campaigns.isSuccess && !campaigns.isFetching;
    return (
      <View style={{ flex: 1, backgroundColor: color.surface.subtle, paddingTop: insets.top }}>
        {failed ? (
          <ErrorState style={{ paddingTop: 120 }} onRetry={() => { me.refetch(); campaigns.refetch(); }} />
        ) : loadedButMissing ? (
          <ErrorState style={{ paddingTop: 120 }} message="This campaign is no longer available." onRetry={() => navigation.goBack()} />
        ) : (
          <LoadingBlock style={{ paddingTop: 120 }} />
        )}
      </View>
    );
  }

  const totals = stats.data?.totals;

  return (
    <View style={{ flex: 1, backgroundColor: color.surface.subtle, paddingTop: insets.top }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: space.xl, paddingVertical: space.md }}>
        <Pressable onPress={() => navigation.goBack()} hitSlop={10}>
          <Feather name="arrow-left" size={22} color={color.text.primary} />
        </Pressable>
        <T variant="heading" numberOfLines={1} style={{ marginLeft: space.lg, flex: 1 }}>
          {campaign.name}
        </T>
        {s ? <TonePill label={s.label} tone={s.tone} /> : null}
      </View>

      <ScrollView
        contentContainerStyle={{ padding: space['2xl'], paddingBottom: space['3xl'] }}
        refreshControl={<RefreshControl refreshing={campaigns.isRefetching} onRefresh={() => { void campaigns.refetch(); void stats.refetch(); }} tintColor={color.brand[500]} />}
      >
        {/* §6.1 timeline, human-worded. Terminal failures show their reason. */}
        <Card style={{ padding: space.xl }}>
          {TIMELINE.map((t, i) => {
            const reached = pos >= i && !['CANCELLED', 'REJECTED'].includes(campaign.status);
            return (
              <View key={t.key} style={{ flexDirection: 'row', alignItems: 'center', marginTop: i === 0 ? 0 : space.md }}>
                <View
                  style={{
                    width: 10, height: 10, borderRadius: 5,
                    backgroundColor: reached ? color.success : color.border.strong,
                  }}
                />
                <T variant="label" tone={reached ? 'ink' : 'muted'} style={{ marginLeft: space.md }}>
                  {t.label}
                </T>
              </View>
            );
          })}
          {['CANCELLED', 'REJECTED'].includes(campaign.status) ? (
            <View style={{ marginTop: space.md, backgroundColor: color.soft.danger, borderRadius: radius.md, padding: space.md }}>
              <T variant="caption" style={{ color: color.error }}>
                {campaign.status === 'CANCELLED' ? 'Cancelled' : 'Not approved'}
                {campaign.statusReason ? ` — ${campaign.statusReason}` : ''}
              </T>
            </View>
          ) : null}
        </Card>

        {/* §12.3 stats — the rollup numbers (reconciled with raw events). */}
        <Card style={{ padding: space.xl, marginTop: space.lg }}>
          <T variant="label" weight="semibold">
            Performance
          </T>
          {totals ? (
            <View style={{ flexDirection: 'row', marginTop: space.lg }}>
              <StatCell label="Viewable" value={Number(totals.viewableImpressions).toLocaleString('en-US')} />
              <StatCell label="Clicks" value={Number(totals.clicks).toLocaleString('en-US')} />
              <StatCell label="CTR" value={`${(Number(totals.ctr) * 100).toFixed(1)}%`} />
              <StatCell label="Spend" value={money(totals.spend, campaign.currency)} />
            </View>
          ) : stats.isError ? (
            // [WR-031] A failed stats read is not "no numbers yet".
            <T variant="caption" tone="error" style={{ marginTop: space.sm }}>
              Couldn't load performance — pull to refresh or reopen this screen.
            </T>
          ) : (
            <T variant="caption" tone="muted" style={{ marginTop: space.sm }}>
              Numbers appear after your first live day (rolled up nightly).
            </T>
          )}
        </Card>

        {/* Creatives + review state. */}
        <Card style={{ padding: space.xl, marginTop: space.lg }}>
          <T variant="label" weight="semibold">
            Creatives
          </T>
          {(campaign.creatives ?? []).length === 0 ? (
            <T variant="caption" tone="muted" style={{ marginTop: space.sm }}>
              No creative uploaded yet — your campaign cannot go live without an approved creative.
            </T>
          ) : (
            (campaign.creatives as any[]).map((cr) => (
              <View key={cr.id} style={{ flexDirection: 'row', justifyContent: 'space-between', marginTop: space.md }}>
                <T variant="caption" tone="muted">
                  {cr.transcodeStatus === 'QUEUED' ? 'Processing video…' : 'Creative'}
                </T>
                <TonePill
                  label={cr.status === 'APPROVED' ? 'Approved' : cr.status === 'REJECTED' ? 'Rejected' : 'In review'}
                  tone={cr.status === 'APPROVED' ? 'success' : cr.status === 'REJECTED' ? 'error' : 'brand'}
                />
              </View>
            ))
          )}
        </Card>

        {/* Money line + unpaid-invoice nudge. */}
        <Card style={{ padding: space.xl, marginTop: space.lg }}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
            <T variant="label" weight="semibold">
              Total
            </T>
            <T variant="label" weight="semibold">
              {money(campaign.totalAmount, campaign.currency)}
            </T>
          </View>
          {(campaign.invoices as any[]).map((inv) => (
            <View key={inv.id} style={{ flexDirection: 'row', justifyContent: 'space-between', marginTop: space.sm }}>
              <T variant="caption" tone="muted">
                {inv.number}
              </T>
              {/* Lower-cased, not the raw enum shouting — same fact, human case. */}
              <T variant="caption" tone="muted">
                {String(inv.status).toLowerCase().replaceAll('_', ' ')}
              </T>
            </View>
          ))}
        </Card>

        {/* Actions per state — the server enforces legality; we surface it. */}
        {!terminal ? (
          <View style={{ marginTop: space['2xl'], gap: space.md }}>
            {campaign.status === 'LIVE' ? (
              <PillButton label="Pause campaign" variant="outline" loading={actions.pause.isPending} onPress={() => actions.pause.mutate(campaign.id)} />
            ) : null}
            {campaign.status === 'PAUSED' ? (
              <PillButton label="Resume campaign" loading={actions.resume.isPending} onPress={() => actions.resume.mutate(campaign.id)} />
            ) : null}
            {['PENDING_REVIEW', 'SCHEDULED', 'LIVE', 'PAUSED'].includes(campaign.status) ? (
              <PillButton label="Cancel campaign…" variant="outline" loading={acting} onPress={confirmCancel} />
            ) : null}
          </View>
        ) : null}
      </ScrollView>
    </View>
  );
}
