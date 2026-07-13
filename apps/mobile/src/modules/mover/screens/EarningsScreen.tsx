/** @jsxImportSource react */
import React from 'react';
import { ScrollView, View } from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { color, radius, space } from '@swift/ui';
import { Card, Header, LinkText, LoadingBlock, Screen, T, TonePill } from '../../../kit';
import { useMoverKind, useMoverStats, useMoverSubscription, useEarningsSummary, useEarnings } from '../../../hooks';
import { money } from '../../../lib/money';
import { dateLabel } from '../shared';

function StatTile({ label, total, count, sub }: { label: string; total: number; count?: number; sub?: string }) {
  return (
    <Card style={{ flex: 1, paddingVertical: space.md }}>
      <T variant="caption" weight="bold" tone="muted" style={{ letterSpacing: 1 }}>
        {label.toUpperCase()}
      </T>
      <T variant="heading" numberOfLines={1} style={{ marginTop: 2 }}>
        {money(total)}
      </T>
      <T variant="caption" tone="muted">
        {sub ?? `${count ?? 0} ${count === 1 ? 'job' : 'jobs'}`}
      </T>
    </Card>
  );
}

function earnLabel(t?: string) {
  const s = (t ?? 'Trip').replace(/_/g, ' ').toLowerCase();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** The mover's flat weekly fee — status straight off the subscription engine. */
function WeeklyFeeCard({ sub }: { sub: any }) {
  if (!sub) return null;
  const pill = sub.isTrialActive
    ? { label: 'Free trial', tone: 'brand' as const }
    : sub.isInGracePeriod
      ? { label: 'Grace period', tone: 'error' as const }
      : sub.status === 'ACTIVE'
        ? { label: 'Active', tone: 'success' as const }
        : { label: String(sub.status ?? '').toLowerCase() || 'Inactive', tone: 'neutral' as const };
  const line = sub.isTrialActive && sub.trialEndDate
    ? `Trial ends ${dateLabel(sub.trialEndDate)} · then ${money(sub.customRate ?? sub.weeklyRate)}/week`
    : sub.isInGracePeriod && sub.gracePeriodEnd
      ? `Pay by ${dateLabel(sub.gracePeriodEnd)} to keep going online`
      : `${money(sub.customRate ?? sub.weeklyRate)}/week${sub.nextBillingDate ? ` · next bill ${dateLabel(sub.nextBillingDate)}` : ''}`;
  return (
    <Card style={{ marginTop: space.md }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
        <T variant="body" weight="semibold">
          Your weekly fee
        </T>
        <TonePill label={pill.label} tone={pill.tone} />
      </View>
      <T variant="label" tone="muted" style={{ marginTop: 4 }}>
        {line}
      </T>
      <T variant="caption" tone="muted" style={{ marginTop: 4 }}>
        The flat fee is Swift&apos;s only charge — every fare stays yours.
      </T>
    </Card>
  );
}

export function EarningsScreen({ navigation }: any) {
  const { kind } = useMoverKind();
  const summaryQ = useEarningsSummary<any>(kind);
  const historyQ = useEarnings<any>(kind);
  const stats = useMoverStats(kind);
  const subQ = useMoverSubscription(kind);
  const s: any = summaryQ.data ?? {};
  const raw: any = historyQ.data;
  const history: any[] = Array.isArray(raw) ? raw : raw?.data ?? raw?.earnings ?? [];
  const onlineHours = (stats.data as any)?.onlineHoursToday;
  const weekDeliveries = (stats.data as any)?.weekDeliveries;

  // "Where your money came from" — split fees vs tips across recent jobs. Tips
  // now include post-delivery ones customers add later, so this surfaces that
  // income instead of burying it in the total.
  const tips = history.filter((e) => e?.type === 'TIP').reduce((a, e) => a + Number(e.amount ?? 0), 0);
  const fees = history.filter((e) => e?.type && e.type !== 'TIP').reduce((a, e) => a + Number(e.amount ?? 0), 0);

  return (
    <Screen>
      <Header title="Earnings" />
      {summaryQ.isLoading ? (
        <LoadingBlock />
      ) : (
        <ScrollView contentContainerStyle={{ paddingHorizontal: space['2xl'], paddingBottom: space['3xl'] }} showsVerticalScrollIndicator={false}>
          {/* This-week hero */}
          <Card>
            <T variant="caption" weight="bold" tone="muted" style={{ letterSpacing: 1 }}>
              THIS WEEK
            </T>
            <T variant="display" style={{ marginTop: 2 }}>
              {money(s.thisWeek?.total ?? 0)}
            </T>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 2 }}>
              <MaterialCommunityIcons name="check-decagram" size={14} color={color.success} />
              <T variant="caption" weight="bold" tone="success">
                100% yours · cash · 0% commission
              </T>
            </View>
            <T variant="caption" tone="muted" style={{ marginTop: 2 }}>
              {s.thisWeek?.count ?? 0} jobs this week
              {weekDeliveries != null ? ` · ${weekDeliveries} delivered` : ''}
              {onlineHours != null ? ` · ${onlineHours}h online today` : ''}
            </T>
          </Card>

          {/* Stat grid */}
          <View style={{ flexDirection: 'row', gap: space.md, marginTop: space.md }}>
            <StatTile label="Today" total={s.today?.total ?? 0} count={s.today?.count ?? 0} />
            <StatTile label="This month" total={s.thisMonth?.total ?? 0} count={s.thisMonth?.count ?? 0} />
          </View>
          <View style={{ flexDirection: 'row', gap: space.md, marginTop: space.md }}>
            <StatTile label="All time" total={s.allTime?.total ?? 0} count={s.allTime?.count ?? 0} />
            <StatTile label="Pending payout" total={s.pendingPayout ?? 0} sub="cash in hand" />
          </View>

          {/* Where the money came from — fees vs tips across recent jobs */}
          {(fees > 0 || tips > 0) ? (
            <Card style={{ marginTop: space.md }}>
              <T variant="caption" weight="bold" tone="muted" style={{ letterSpacing: 1 }}>
                RECENT BREAKDOWN
              </T>
              <View style={{ flexDirection: 'row', marginTop: space.sm }}>
                <View style={{ flex: 1 }}>
                  <T variant="heading">{money(fees)}</T>
                  <T variant="caption" tone="muted">Job fees</T>
                </View>
                <View style={{ flex: 1 }}>
                  <T variant="heading">{money(tips)}</T>
                  <T variant="caption" tone="muted">Tips</T>
                </View>
              </View>
            </Card>
          ) : null}

          {/* Weekly flat fee — billing transparency for the mover */}
          <WeeklyFeeCard sub={subQ.data} />

          {/* Recent earnings */}
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: space.xl, marginBottom: space.md }}>
            <T variant="heading">Recent</T>
            <LinkText label="All jobs" onPress={() => navigation?.navigate?.('JobHistory')} />
          </View>
          {history.length === 0 ? (
            <T variant="label" tone="muted">
              Completed jobs land here with the cash you took on each.
            </T>
          ) : (
            <Card style={{ paddingVertical: space.sm }}>
              {history.slice(0, 30).map((e: any, i: number) => (
                <View
                  key={e.id ?? i}
                  style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    paddingVertical: space.sm,
                    borderTopWidth: i > 0 ? 1 : 0,
                    borderTopColor: color.border.subtle,
                  }}
                >
                  <View style={{ width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center', backgroundColor: '#E8F6EE' }}>
                    <MaterialCommunityIcons name="cash" size={15} color={color.success} />
                  </View>
                  <View style={{ flex: 1, marginLeft: space.md }}>
                    <T variant="label" weight="semibold">
                      {earnLabel(e.type)}
                    </T>
                    <T variant="caption" tone="muted">
                      {dateLabel(e.createdAt)}
                    </T>
                  </View>
                  <T variant="label" weight="bold">
                    {money(Number(e.amount ?? 0))}
                  </T>
                </View>
              ))}
            </Card>
          )}
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm, borderRadius: radius.lg, backgroundColor: color.brand[50], padding: space.md, marginTop: space.lg }}>
            <MaterialCommunityIcons name="calendar-check" size={16} color={color.brand[600]} />
            <T variant="caption" weight="semibold" tone="deep" style={{ flex: 1 }}>
              You keep every cent — Swift only charges the flat weekly fee. No commission, ever.
            </T>
          </View>
        </ScrollView>
      )}
    </Screen>
  );
}
