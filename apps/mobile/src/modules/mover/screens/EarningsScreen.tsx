/** @jsxImportSource react */
import React, { useEffect, useRef } from 'react';
import { AccessibilityInfo, Animated, ScrollView, StyleSheet, View } from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { color, fontSize, motion, radius, space } from '@swift/ui';
import { Card, ErrorState, Header, LinkText, LoadingBlock, PillButton, Screen, StatTile as KitStatTile, T, TonePill } from '../../../kit';
import { useMoverKind, useMoverStats, useMoverSubscription, useEarningsSummary, useEarnings, useCashSettlements, useConfirmCashSettlement } from '../../../hooks';
import { money } from '../../../lib/money';
import { dateLabel } from '../shared';
import { useMutation } from '@tanstack/react-query';
import { API_URL, driverApi, riderApi } from '../../../services/api';
import { openPayLink } from '../../../lib/payLink';
import { BillingStatusBlock } from '../../../components/billing/BillingSurfaces';
import {
  requireAuthSessionForPrincipal,
  requireAuthSessionSnapshot,
} from '../../../stores/authStore';
import {
  earningLabel,
  earningRows,
  earningsWindowTotal,
  hasEarningRowsPayload,
  moneyOrDash,
  recentEarningsBreakdown,
  serverCount,
  serverDate,
  serverNumber,
  serverRecord,
  serverRecords,
  serverText,
} from '../earner-data';

/** Thin domain wrapper over the kit's StatTile [Wave 3 part 2]: this screen's
 *  tiles always show money-or-dash with a job-count detail line. */
function StatTile({
  label,
  total,
  count,
  sub,
}: {
  label: string;
  total: unknown;
  count?: number;
  sub?: string;
}) {
  return <KitStatTile size="md" label={label} value={moneyOrDash(total)} sub={sub ?? countDetail(count, 'job', 'jobs')} />;
}

function countDetail(count: number | undefined, singular: string, plural: string) {
  return count == null ? undefined : `${count} ${count === 1 ? singular : plural}`;
}

function earnLabel(t?: string) {
  return earningLabel(t);
}

function EarningsHero({ total, facts }: { total: unknown; facts: string[] }) {
  const opacity = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    let active = true;
    let animation: Animated.CompositeAnimation | undefined;
    void AccessibilityInfo.isReduceMotionEnabled()
      .then((reduceMotion) => {
        if (!active) return;
        if (reduceMotion) {
          opacity.setValue(1);
          return;
        }
        animation = Animated.timing(opacity, {
          toValue: 1,
          duration: motion.duration.gentle,
          useNativeDriver: true,
        });
        animation.start();
      })
      .catch(() => {
        if (active) opacity.setValue(1);
      });
    return () => {
      active = false;
      animation?.stop();
    };
  }, [opacity]);

  return (
    <Animated.View style={{ opacity }}>
      <Card pad={false} style={{ backgroundColor: color.brand[50] }}>
        <View style={{ flexDirection: 'row' }}>
          <View
            style={{
              alignSelf: 'stretch',
              width: space.xs,
              borderRadius: radius.full,
              backgroundColor: color.brand[500],
            }}
          />
          <View style={{ flex: 1, padding: space.lg }}>
            <T variant="micro" tone="muted">THIS WEEK</T>
            <T variant="numL" style={{ marginTop: space.xs }}>{moneyOrDash(total)}</T>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.xs, marginTop: space.xs }}>
              <MaterialCommunityIcons name="check-decagram" size={fontSize.xs} color={color.success} />
              <T variant="caption" weight="bold" tone="success" style={{ flex: 1 }}>
                Every fare stays yours · cash · no commission
              </T>
            </View>
            {facts.length ? (
              <T variant="caption" tone="muted" style={{ marginTop: space.sm }}>
                {facts.join(' · ')}
              </T>
            ) : null}
          </View>
        </View>
      </Card>
    </Animated.View>
  );
}

/** MMG deliveries: the customer paid the STORE, so the store owes the rider
 *  the delivery fee in cash. This is that ledger — confirm as stores pay up. */
function StoreOwesYouCard({ ledger }: { ledger: unknown }) {
  const confirm = useConfirmCashSettlement();
  const source = serverRecord(ledger);
  const rows = serverRecords(source?.['unsettled']);
  if (rows.length === 0) return null;
  const owed = serverNumber(serverRecord(source?.['summary'])?.['owed']);

  return (
    <Card style={{ marginTop: space.md }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
        <T variant="micro" tone="muted">STORES OWE YOU</T>
        <T variant="numM">{moneyOrDash(owed)}</T>
      </View>
      <T variant="caption" tone="muted" style={{ marginTop: space.xs }}>
        MMG orders — the customer paid the store, so your delivery fee comes from them in cash.
      </T>
      {rows.map((row, index) => {
        const id = serverText(row['id']);
        const vendorName = serverText(serverRecord(row['vendor'])?.['name']);
        const orderNumber = serverText(row['orderNumber']);
        const createdAt = serverDate(row['createdAt']);
        const status = serverText(row['status'])?.toUpperCase();
        const meta = [orderNumber ? `#${orderNumber}` : undefined, createdAt ? dateLabel(createdAt) : undefined]
          .filter((part): part is string => !!part)
          .join(' · ');
        const canConfirm = !!id && (status === 'OWED' || status === 'STORE_CONFIRMED');
        return (
          <View key={id ?? `cash-row-${index}`}>
            {index > 0 ? (
              <View
                style={{
                  height: StyleSheet.hairlineWidth,
                  backgroundColor: color.border.subtle,
                  marginVertical: space.md,
                }}
              />
            ) : (
              <View style={{ height: space.md }} />
            )}
            <View style={{ flexDirection: 'row', alignItems: 'center' }}>
              <View style={{ flex: 1 }}>
                {vendorName ? (
                  <T variant="label" weight="semibold" numberOfLines={1}>{vendorName}</T>
                ) : null}
                {meta ? <T variant="caption" tone="muted">{meta}</T> : null}
              </View>
              <T variant="numM" style={{ marginLeft: space.md }}>{moneyOrDash(row['amount'])}</T>
            </View>
            {status === 'RIDER_CONFIRMED' ? (
              <T variant="caption" tone="muted" style={{ marginTop: space.sm }}>
                You confirmed — waiting for the store to close it out.
              </T>
            ) : null}
            {status === 'STORE_CONFIRMED' ? (
              <T variant="caption" weight="semibold" style={{ marginTop: space.sm }}>
                {vendorName ? `${vendorName} says they paid you.` : 'The store says they paid you.'}
              </T>
            ) : null}
            {canConfirm ? (
              <PillButton
                label="I received the cash"
                variant="soft"
                size="sm"
                style={{ alignSelf: 'flex-start', marginTop: space.sm }}
                loading={confirm.isPending && confirm.variables === id}
                disabled={confirm.isPending}
                onPress={() => {
                  if (id) confirm.mutate(id);
                }}
              />
            ) : null}
          </View>
        );
      })}
      {confirm.isError ? (
        <T variant="caption" tone="error" style={{ marginTop: space.md }}>
          We couldn&apos;t confirm that cash handover. Try again.
        </T>
      ) : null}
    </Card>
  );
}

/** The mover's flat weekly fee — status straight off the subscription engine. */
function WeeklyFeeCard({ sub, onPay }: { sub: unknown; onPay?: () => void }) {
  const source = serverRecord(sub);
  if (!source) return null;
  const status = serverText(source['status'])?.toUpperCase();
  const isTrial = source['isTrialActive'] === true;
  const isGrace = source['isInGracePeriod'] === true;
  const pill = isTrial
    ? { label: 'Free trial', tone: 'info' as const }
    : isGrace
      ? { label: 'Grace period', tone: 'warning' as const }
      : status === 'ACTIVE'
        ? { label: 'Active', tone: 'success' as const }
        : status === 'PAST_DUE'
          ? { label: 'Past due', tone: 'warning' as const }
          : status === 'SUSPENDED' || status === 'CHURNED'
            ? { label: status === 'SUSPENDED' ? 'Suspended' : 'Churned', tone: 'error' as const }
        : status
          ? { label: status.replace(/_/g, ' ').toLowerCase(), tone: 'neutral' as const }
          : undefined;
  const rate = serverNumber(source['weeklyFeeGyd'] ?? source['customRate'] ?? source['weeklyRate']);
  const trialEnd = serverDate(source['trialEndDate']);
  const graceEnd = serverDate(source['gracePeriodEnd']);
  const nextBill = serverDate(source['nextBillingDate']);
  const needsAttention = isGrace || status === 'PAST_DUE' || status === 'SUSPENDED' || status === 'CHURNED';

  return (
    <Card style={{ marginTop: space.md }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
        <T variant="heading">Your weekly fee</T>
        {pill ? <TonePill label={pill.label} tone={pill.tone} /> : null}
      </View>
      {isTrial && trialEnd ? (
        <T variant="label" tone="muted" style={{ marginTop: space.sm }}>
          Trial ends {dateLabel(trialEnd)}
        </T>
      ) : null}
      {isGrace && graceEnd ? (
        <T variant="label" tone="muted" style={{ marginTop: space.sm }}>
          Pay by {dateLabel(graceEnd)} to keep going online
        </T>
      ) : null}
      {rate != null || nextBill ? (
        <View style={{ flexDirection: 'row', alignItems: 'baseline', flexWrap: 'wrap', gap: space.xs, marginTop: space.sm }}>
          {rate != null ? <T variant="numM">{money(rate)}</T> : null}
          {rate != null ? (
            <T variant="caption" tone="muted">{isTrial ? '/week after trial' : '/week'}</T>
          ) : null}
          {nextBill ? (
            <T variant="caption" tone="muted">
              {rate != null ? '· next bill ' : 'Next bill '}{dateLabel(nextBill)}
            </T>
          ) : null}
        </View>
      ) : null}
      <T variant="caption" tone="muted" style={{ marginTop: space.sm }}>
        The flat fee is Swift&apos;s only charge — every fare stays yours.
      </T>
      {needsAttention ? <BillingStatusBlock sub={sub} onPay={onPay} compact /> : null}
    </Card>
  );
}

function EarningsTools({
  sub,
  onTopUp,
  onStatement,
  statementLoading,
  statementError,
}: {
  sub: unknown;
  onTopUp: () => void;
  onStatement: () => void;
  statementLoading: boolean;
  statementError: boolean;
}) {
  const source = serverRecord(sub);
  const wallet = serverNumber(source?.['walletBalanceGyd']);
  return (
    <Card style={{ marginTop: space.md }}>
      {wallet != null ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
          <T variant="micro" tone="muted">WALLET BALANCE</T>
          <T variant="numM">{money(wallet)}</T>
        </View>
      ) : null}
      {source ? (
        <PillButton
          label="Top up"
          size="md"
          onPress={onTopUp}
          style={{ marginTop: wallet != null ? space.md : undefined }}
        />
      ) : null}
      <PillButton
        label="Get earnings statement"
        variant="outline"
        size="md"
        loading={statementLoading}
        onPress={onStatement}
        style={{ marginTop: source ? space.md : undefined }}
      />
      {statementError ? (
        <T variant="caption" tone="error" center style={{ marginTop: space.sm }}>
          Couldn’t open the statement — try again.
        </T>
      ) : null}
    </Card>
  );
}

function RecentEarningRow({ entry, index }: { entry: Record<string, unknown>; index: number }) {
  const type = serverText(entry['type'])?.toUpperCase();
  const label = earnLabel(type);
  const createdAt = serverDate(entry['createdAt']);
  const icon: React.ComponentProps<typeof MaterialCommunityIcons>['name'] | undefined = type === 'TIP'
    ? 'heart-outline'
    : type === 'TAXI_FARE'
      ? 'taxi'
      : type === 'COURIER_FEE'
        ? 'package-variant-closed'
        : type === 'DELIVERY_FEE'
          ? 'bike-fast'
          : undefined;
  return (
    <View>
      {index > 0 ? <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: color.border.subtle }} /> : null}
      <View style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: space.sm }}>
        {icon ? (
          <View
            style={{
              width: space['3xl'],
              height: space['3xl'],
              borderRadius: radius.full,
              alignItems: 'center',
              justifyContent: 'center',
              backgroundColor: color.surface.sunken,
            }}
          >
            <MaterialCommunityIcons name={icon} size={fontSize.base} color={color.text.secondary} />
          </View>
        ) : null}
        <View style={{ flex: 1, marginLeft: icon ? space.md : undefined }}>
          {label ? <T variant="label" weight="semibold">{label}</T> : null}
          {createdAt ? <T variant="caption" tone="muted">{dateLabel(createdAt)}</T> : null}
        </View>
        <T variant="numM">{moneyOrDash(entry['amount'])}</T>
      </View>
    </View>
  );
}

export function EarningsScreen({ navigation }: any) {
  const mover = useMoverKind();
  const { kind } = mover;
  const summaryQ = useEarningsSummary<unknown>(kind);
  const historyQ = useEarnings<unknown>(kind);
  const stats = useMoverStats(kind);
  const subQ = useMoverSubscription(kind);
  const ledgerQ = useCashSettlements(kind);

  // Signed short-lived link (the JWT can't ride an in-app browser).
  const statement = useMutation({
    mutationFn: async () => {
      const owner = requireAuthSessionSnapshot();
      const r = await (kind === 'DRIVER'
        ? driverApi.earningsStatement(owner)
        : riderApi.earningsStatement(owner));
      requireAuthSessionForPrincipal(owner);
      const path = serverText(r.data?.data?.path);
      // [WR-033] A mint that returns no path, or a link that can't open on
      // this phone, must FAIL the mutation — the error line below is the
      // honest signal; success used to be claimed silently either way.
      if (!path) throw new Error('Statement link missing from the response.');
      const opened = await openPayLink(`${API_URL}${path}`);
      requireAuthSessionForPrincipal(owner);
      if (opened === false) throw new Error("Couldn't open the statement on this phone.");
    },
  });

  const summary = serverRecord(summaryQ.data);
  const statsData = serverRecord(stats.data);
  const history = earningRows(historyQ.data);
  const historyResponseValid = hasEarningRowsPayload(historyQ.data);
  const breakdown = historyQ.isError || !historyResponseValid
    ? undefined
    : recentEarningsBreakdown(history);
  const isDriver = kind === 'DRIVER';
  const todayJobs = isDriver
    ? serverCount(summary?.['todayRides'])
    : serverCount(statsData?.['todayDeliveries']);
  const weekDeliveries = isDriver ? undefined : serverCount(statsData?.['weekDeliveries']);
  const allTimeJobs = isDriver
    ? serverCount(summary?.['totalRides'])
    : serverCount(statsData?.['totalDeliveries']);
  const onlineHours = isDriver ? undefined : serverNumber(statsData?.['onlineHoursToday']);
  const weekFacts = [
    weekDeliveries == null ? undefined : `${weekDeliveries} delivered this week`,
    onlineHours == null ? undefined : `${onlineHours}h online today`,
  ].filter((fact): fact is string => !!fact);
  const todayDetail = isDriver
    ? countDetail(todayJobs, 'trip', 'trips')
    : countDetail(todayJobs, 'job', 'jobs');
  const allTimeDetail = isDriver
    ? countDetail(allTimeJobs, 'trip', 'trips')
    : countDetail(allTimeJobs, 'job', 'jobs');

  return (
    <Screen>
      <Header title="Earnings" />
      {mover.loading ? (
        <LoadingBlock />
      ) : mover.error ? (
        <ErrorState
          message="We couldn't open your earner profile. Check your connection and try again."
          onRetry={() => mover.refetch()}
        />
      ) : !kind ? (
        <ErrorState
          message="We couldn't tell which earner profile to open. Try again."
          onRetry={() => mover.refetch()}
        />
      ) : summaryQ.isLoading ? (
        <LoadingBlock />
      ) : summaryQ.isError ? (
        // Honest failure — never render an optimistic $0 that reads as "you
        // earned nothing" when the request simply failed.
        <ErrorState message="We couldn't load your earnings. Check your connection and try again." onRetry={() => summaryQ.refetch()} />
      ) : (
        <ScrollView contentContainerStyle={{ paddingHorizontal: space['2xl'], paddingBottom: space['3xl'] }} showsVerticalScrollIndicator={false}>
          <EarningsHero
            total={earningsWindowTotal(summaryQ.data, 'thisWeek', 'week')}
            facts={weekFacts}
          />

          <View style={{ flexDirection: 'row', gap: space.md, marginTop: space.md }}>
            <StatTile
              label="TODAY"
              total={earningsWindowTotal(summaryQ.data, 'today')}
              sub={todayDetail}
            />
            <StatTile
              label="THIS MONTH"
              total={earningsWindowTotal(summaryQ.data, 'thisMonth', 'month')}
            />
          </View>
          <View style={{ flexDirection: 'row', gap: space.md, marginTop: space.md }}>
            <StatTile
              label="ALL TIME"
              total={earningsWindowTotal(summaryQ.data, 'allTime')}
              sub={allTimeDetail}
            />
          </View>

          {breakdown ? (
            <Card style={{ marginTop: space.md }}>
              <T variant="micro" tone="muted">RECENT BREAKDOWN</T>
              <View style={{ flexDirection: 'row', marginTop: space.sm }}>
                {breakdown.fees != null ? (
                  <View style={{ flex: 1 }}>
                    <T variant="numM">{money(breakdown.fees)}</T>
                    <T variant="caption" tone="muted">Job fees</T>
                  </View>
                ) : null}
                {breakdown.tips != null ? (
                  <View style={{ flex: 1 }}>
                    <T variant="numM">{money(breakdown.tips)}</T>
                    <T variant="caption" tone="muted">Tips</T>
                  </View>
                ) : null}
              </View>
            </Card>
          ) : null}

          {kind === 'RIDER' ? (
            ledgerQ.isError ? (
              <Card style={{ marginTop: space.md }}>
                <T variant="label" tone="error">We couldn&apos;t load the store cash ledger.</T>
                <View style={{ marginTop: space.sm }}>
                  <LinkText label="Try again" onPress={() => ledgerQ.refetch()} />
                </View>
              </Card>
            ) : (
              <StoreOwesYouCard ledger={ledgerQ.data} />
            )
          ) : null}

          <WeeklyFeeCard sub={subQ.data} onPay={() => navigation?.navigate?.('MySwiftNumber')} />

          <EarningsTools
            sub={subQ.data}
            onTopUp={() => navigation?.navigate?.('MySwiftNumber')}
            onStatement={() => statement.mutate()}
            statementLoading={statement.isPending}
            statementError={statement.isError}
          />

          {/* Recent earnings */}
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: space.xl, marginBottom: space.md }}>
            <T variant="heading">Recent</T>
            <LinkText label="All jobs" onPress={() => navigation?.navigate?.('JobHistory')} />
          </View>
          {historyQ.isLoading ? (
            <LoadingBlock />
          ) : historyQ.isError ? (
            <ErrorState
              message="We couldn't load your recent earnings. Check your connection and try again."
              onRetry={() => historyQ.refetch()}
            />
          ) : !historyResponseValid ? (
            <ErrorState
              message="Your recent earnings weren't included in the response. Try again."
              onRetry={() => historyQ.refetch()}
            />
          ) : history.length === 0 ? (
            <T variant="label" tone="muted">
              Completed jobs and tips land here as they&apos;re recorded.
            </T>
          ) : (
            <Card style={{ paddingVertical: space.sm }}>
              {history.map((entry, index) => (
                <RecentEarningRow
                  key={serverText(entry['id']) ?? `earning-row-${index}`}
                  entry={entry}
                  index={index}
                />
              ))}
            </Card>
          )}
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm, borderRadius: radius.lg, backgroundColor: color.surface.sunken, padding: space.md, marginTop: space.lg }}>
            <MaterialCommunityIcons name="calendar-check" size={fontSize.base} color={color.text.secondary} />
            <T variant="caption" weight="semibold" tone="muted" style={{ flex: 1 }}>
              You keep every cent — Swift only charges the flat weekly fee. No commission, ever.
            </T>
          </View>
        </ScrollView>
      )}
    </Screen>
  );
}
