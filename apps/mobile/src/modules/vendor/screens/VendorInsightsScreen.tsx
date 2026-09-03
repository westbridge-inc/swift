/** @jsxImportSource react */
import { useState, useEffect, type ReactNode } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Alert, RefreshControl, ScrollView, View } from 'react-native';
import { Image } from 'expo-image';
import { color, radius, space } from '@swift/ui';
import { Feather, MaterialCommunityIcons } from '@expo/vector-icons';
import { Card, ErrorState, LinkText, LoadingBlock, PillButton, Screen, Segmented, T } from '../../../kit';
import { DeltaBadge, GUTTER, InlineInput, KpiTile, fmtDate } from '../shared';
import { classifyOwedLedger, markPaidPrompt } from '../../../lib/riderFeesOwed';
import { errorMessage } from '../../../lib/apiError';
import { StandingCard } from '../../../components/StandingCard';
import { API_URL, vendorApi } from '../../../services/api';
import { openPayLink } from '../../../lib/payLink';
import {
  useMyStoreReviews,
  useRespondReview,
  useVendorStanding,
  useVendorItemFeedback,
  useVendorAnalytics,
  useVendorRevenue,
  useVendorOps,
  useVendorCashSettlements,
  useConfirmVendorCashSettlement,
  usePopularItems,
  useBusyHours,
  useRepeatCustomers,
} from '../../../hooks/vendorops';
import { requireAuthSessionForPrincipal, requireAuthSessionSnapshot } from '../../../stores/authStore';
import { useVendorPreview } from '../../../stores/vendorPreview';
import { money } from '../../../lib/money';
import { mediaUrl } from '../../../lib/images';
import {
  TabHeader,
  type RevenueDay,
  numericFact,
  hasTrailingGuyanaDays,
  reconciledRevenueDays,
  windowTotals,
} from '../shared';

/** Owned single-brand chart. Bars are decorative; the parent revenue sentence is
 * the accessible numerical summary, so a screen reader never walks 90 glyphs. */
function RevenueChart({ daily }: { daily: RevenueDay[] }) {
  const chartHeight = space['5xl'] + space['5xl'];
  const peak = Math.max(...daily.map((day) => day.revenue), 0);
  const scaleMax = Math.max(peak, 1);
  const today = daily.find((day) => day.isToday);
  const shortLabel = (value: string) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return value.slice(0, 1).toUpperCase();
    return 'SMTWTFS'[new Date(`${value}T12:00:00Z`).getUTCDay()]!;
  };
  const dateLabel = (value: string) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
    const d = new Date(`${value}T12:00:00Z`);
    return `${d.getUTCDate()}/${d.getUTCMonth() + 1}`;
  };
  const chartGap = daily.length <= 7 ? space.sm : daily.length <= 30 ? space.xs : undefined;

  return (
    <View
      accessible
      accessibilityRole="image"
      accessibilityLabel={`Revenue trend for ${daily.length} days. Peak ${money(peak)}${today ? `. Today ${money(today.revenue)}` : ''}.`}
      style={{ marginTop: space.lg }}
    >
      {today && daily.length > 7 ? (
        // [Wave 3 · ref 21 + law 3] The number is INK — brand belongs to
        // today's bar, never to a money caption.
        <T variant="caption" weight="semibold" style={{ alignSelf: 'flex-end', marginBottom: space.sm }}>
          Today {money(today.revenue)}
        </T>
      ) : null}
      {/* [Wave 3 · ref 21] Today is the ONLY loud bar — every other day sits
          in a brand-50 wash (the cockpit's #933 grammar). On the 7-day lens,
          today's value floats right above its own bar, k-formatted, exactly
          where the reference draws it. */}
      <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: chartGap, height: chartHeight + (daily.length <= 7 ? space.xl : 0) }} importantForAccessibility="no-hide-descendants">
        {daily.map((day) => (
          <View key={day.date} style={{ flex: 1, justifyContent: 'flex-end' }}>
            {day.isToday && daily.length <= 7 && day.revenue > 0 ? (
              <T variant="caption" weight="semibold" center numberOfLines={1}>
                {(Math.round(day.revenue / 100) / 10).toFixed(1).replace(/\.0$/, '')}k
              </T>
            ) : null}
            <View
              style={{
                borderTopLeftRadius: radius.sm,
                borderTopRightRadius: radius.sm,
                height: Math.max(space.xs, Math.round((day.revenue / scaleMax) * chartHeight)),
                backgroundColor:
                  day.isToday && day.revenue > 0
                    ? color.brand[500]
                    : day.revenue > 0
                      ? color.brand[50]
                      : color.border.subtle,
              }}
            />
          </View>
        ))}
      </View>
      {daily.length <= 7 ? (
        <View style={{ flexDirection: 'row', gap: chartGap, marginTop: space.sm }} importantForAccessibility="no-hide-descendants">
          {daily.map((day) => (
            <View key={day.date} style={{ flex: 1, alignItems: 'center' }}>
              <T variant="caption" weight={day.isToday ? 'bold' : 'medium'} tone={day.isToday ? 'brand' : 'muted'}>
                {shortLabel(day.date)}
              </T>
            </View>
          ))}
        </View>
      ) : (
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginTop: space.sm }} importantForAccessibility="no-hide-descendants">
          <T variant="caption" tone="muted">
            {dateLabel(daily[0]!.date)}
          </T>
          <T variant="caption" tone="muted">
            peak {money(peak)}
          </T>
          <T variant="caption" tone="muted">
            {dateLabel(daily[daily.length - 1]!.date)}
          </T>
        </View>
      )}
    </View>
  );
}

function TopItemsCard({ items, sample }: { items: any[]; sample: boolean }) {
  const ranked = items.filter((item) => {
    const lifetime = numericFact(item.totalOrdered) ?? 0;
    const recent = numericFact(item.recentOrders ?? item.count) ?? 0;
    return lifetime > 0 || recent > 0;
  });
  const lifetimeRank = !sample;
  return (
    <Card style={{ marginBottom: space.md }}>
      <T variant="micro" tone="muted">
        {lifetimeRank ? 'MOST ORDERED · LIFETIME' : 'POPULAR ITEMS · SAMPLE'}
      </T>
      {lifetimeRank ? (
        <T variant="caption" tone="muted" style={{ marginTop: space.xs }}>
          Ranked by all-time orders placed; the second count is quantity ordered in the last 30 days.
        </T>
      ) : null}
      {ranked.length === 0 ? (
        <T variant="label" tone="muted" style={{ marginTop: space.sm }}>
          Your most-ordered items will rank here once orders come in.
        </T>
      ) : (
        ranked.map((item, i) => (
          <View key={item.id ?? `${item.name}-${i}`} style={{ flexDirection: 'row', alignItems: 'center', marginTop: space.md }}>
            <T variant="numM" tone="muted" style={{ width: space['2xl'] }}>
              {i + 1}
            </T>
            {item.imageUrl ? (
              <Image
                source={{ uri: mediaUrl(item.imageUrl)! }}
                style={{ width: space['4xl'], height: space['4xl'], borderRadius: radius.sm }}
                contentFit="cover"
                accessibilityLabel={`${item.name} photo`}
              />
            ) : (
              <View style={{ width: space['4xl'], height: space['4xl'], borderRadius: radius.sm, alignItems: 'center', justifyContent: 'center', backgroundColor: color.brand[50] }}>
                <Feather name="image" size={14} color={color.text.muted} />
              </View>
            )}
            <View style={{ flex: 1, marginLeft: space.sm }}>
              <T variant="label" weight="semibold" numberOfLines={1}>
                {item.name}
              </T>
              <T variant="caption" tone="muted">
                {item.category?.name ?? 'Catalogue item'}
              </T>
            </View>
            <View style={{ alignItems: 'flex-end' }}>
              {numericFact(item.totalOrdered) != null ? (
                <T variant="label" weight="semibold">
                  {numericFact(item.totalOrdered)} orders
                </T>
              ) : null}
              {numericFact(item.recentOrders ?? item.count) != null ? (
                <T variant="caption" tone="muted">
                  {numericFact(item.recentOrders ?? item.count)} {lifetimeRank ? 'ordered in 30d' : 'sample orders'}
                </T>
              ) : null}
            </View>
          </View>
        ))
      )}
    </Card>
  );
}

/** Busy-hours mini chart (§4.1): when the orders actually come in. */
function BusyHoursCard() {
  const q = useBusyHours();
  if (q.isLoading) return null;
  const data = q.data;
  if (!data) return null;
  const hours: Array<{ hour: number; orders: number }> = Array.isArray(data) ? data : data.hours ?? [];
  if (hours.length === 0) return null;
  const total = numericFact((data as any).total) ?? hours.reduce((sum, hour) => sum + Number(hour.orders ?? 0), 0);
  const peak = (data as any).peak ?? hours.reduce((best, hour) => (hour.orders > best.orders ? hour : best), hours[0]!);
  const max = Math.max(...hours.map((h) => h.orders), 1);
  const chartHeight = space['5xl'] + space.lg;
  const fmtHour = (h: number) => (h === 0 ? '12am' : h < 12 ? `${h}am` : h === 12 ? '12pm' : `${h - 12}pm`);
  const axisHours = hours.length <= 8
    ? hours
    : [0, 0.25, 0.5, 0.75, 1].map((fraction) => hours[Math.round((hours.length - 1) * fraction)]!);
  return (
    <Card style={{ marginBottom: space.md }}>
      <View style={{ flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between' }}>
        <T variant="body" weight="semibold">
          Busy hours
        </T>
        {total > 0 ? (
          <T variant="label" tone="muted">
            peak {fmtHour(peak.hour)}
          </T>
        ) : null}
      </View>
      {total === 0 ? (
        <T variant="label" tone="muted" style={{ marginTop: space.sm }}>
          Order times will map out here — staff up for the rush.
        </T>
      ) : (
        <>
          <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: space.xs, height: chartHeight, marginTop: space.md }}>
            {hours.map((h) => (
              <View
                key={h.hour}
                style={{
                  flex: 1,
                  borderTopLeftRadius: radius.sm,
                  borderTopRightRadius: radius.sm,
                  height: Math.max(space.xs, Math.round((h.orders / max) * chartHeight)),
                  backgroundColor: h.orders > 0 ? color.brand[500] : color.border.subtle,
                }}
              />
            ))}
          </View>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginTop: space.sm }}>
            {axisHours.map((entry, index) => (
              <T key={`${entry.hour}-${index}`} variant="caption" tone="muted">
                {fmtHour(entry.hour)}
              </T>
            ))}
          </View>
        </>
      )}
    </Card>
  );
}

/** Reviews with the operator reply box (§4.1 "see ratings, respond"). */
function ReviewsCard() {
  const reviewsQ = useMyStoreReviews();
  const respond = useRespondReview();
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [openId, setOpenId] = useState<string | null>(null);

  const reviews: any[] = (reviewsQ.data?.data ?? []).slice(0, 10);
  if (reviewsQ.isLoading) return null;
  if (reviewsQ.isError && !reviewsQ.data) {
    return (
      <Card style={{ marginBottom: space.md }}>
        <T variant="body" weight="semibold">
          Recent reviews
        </T>
        <T variant="label" tone="muted" style={{ marginTop: space.sm }}>
          Reviews are unavailable right now.
        </T>
        <PillButton label="Retry" size="md" variant="soft" style={{ marginTop: space.sm }} onPress={() => reviewsQ.refetch()} />
      </Card>
    );
  }

  return (
    <Card style={{ marginBottom: space.md }}>
      <T variant="body" weight="semibold">
        Recent reviews
      </T>
      {reviewsQ.isError ? (
        <T variant="caption" tone="muted" style={{ marginTop: space.xs }}>
          Showing the last loaded reviews — refresh did not complete.
        </T>
      ) : null}
      {reviews.length === 0 ? (
        <T variant="label" tone="muted" style={{ marginTop: space.sm }}>
          Reviews land here after customers rate their orders.
        </T>
      ) : (
        reviews.map((r) => (
          <View key={r.id} style={{ marginTop: space.sm, borderTopWidth: 1, borderTopColor: color.border.subtle, paddingTop: space.sm }}>
            <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                <T variant="label" weight="semibold" style={{ flex: 1 }}>
                  {r.rater?.firstName ?? 'Customer'} · <T variant="label" tone="star">{'★'.repeat(Number(r.score) || 0)}</T>
              </T>
              <T variant="caption" tone="muted">
                {new Date(r.createdAt).toLocaleDateString([], { month: 'short', day: 'numeric' })}
              </T>
            </View>
            {r.comment ? (
              <T variant="label" tone="muted" style={{ marginTop: 4 }}>
                {r.comment}
              </T>
            ) : null}

            {r.response && openId !== r.id ? (
              <View style={{ marginLeft: space.lg, marginTop: space.sm, borderRadius: radius.md, backgroundColor: color.surface.subtle, paddingHorizontal: space.md, paddingVertical: space.sm }}>
                <T variant="caption" tone="muted">
                  You replied: {r.response}
                </T>
                <LinkText
                  label="Edit reply"
                  onPress={() => {
                    setOpenId(r.id);
                    setDrafts((s) => ({ ...s, [r.id]: r.response }));
                  }}
                />
              </View>
            ) : openId === r.id ? (
              <View style={{ marginTop: space.sm }}>
                <InlineInput
                  multiline
                  value={drafts[r.id] ?? ''}
                  onChangeText={(t: string) => setDrafts((s) => ({ ...s, [r.id]: t }))}
                  placeholder="Write a public reply…"
                />
                <View style={{ flexDirection: 'row', gap: space.md, marginTop: space.sm }}>
                  <PillButton
                    label="Post reply"
                    size="md"
                    style={{ flex: 1 }}
                    loading={respond.isPending}
                    disabled={!(drafts[r.id] ?? '').trim()}
                    onPress={() => respond.mutate({ id: r.id, response: (drafts[r.id] ?? '').trim() }, { onSuccess: () => setOpenId(null) })}
                  />
                  <PillButton label="Cancel" variant="soft" size="md" style={{ flex: 1 }} onPress={() => setOpenId(null)} />
                </View>
              </View>
            ) : (
              <View style={{ marginTop: space.sm }}>
                <LinkText label="Reply" onPress={() => setOpenId(r.id)} />
              </View>
            )}
          </View>
        ))
      )}
    </Card>
  );
}

/** Movement R9 — Standing module + item-thumbs Pareto (daily-folded, RAT-G). */
function VendorStandingSection() {
  const standingQ = useVendorStanding();
  const thumbsQ = useVendorItemFeedback();
  const flagged = ((thumbsQ.data ?? []) as Array<{ itemId: string; name: string; up: number; down: number }>)
    .filter((r) => r.down > 0)
    .slice(0, 5);
  return (
    <>
      {standingQ.data ? <StandingCard data={standingQ.data} title="Store standing" /> : null}
      {flagged.length > 0 ? (
        <Card style={{ marginBottom: space.md }}>
          <T variant="label" weight="semibold">
            Item feedback — last 30 days
          </T>
          <View style={{ marginTop: space.sm, gap: 4 }}>
            {flagged.map((r) => (
              <View key={r.itemId} style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                <T variant="caption" numberOfLines={1} style={{ flex: 1 }}>
                  {r.name}
                </T>
                <T variant="caption" tone="muted">
                  👎 {r.down}
                  {r.up > 0 ? `  ·  👍 ${r.up}` : ''}
                </T>
              </View>
            ))}
          </View>
        </Card>
      ) : null}
    </>
  );
}

/** Ratings histogram — the reviews endpoint's score distribution, drawn as bars. */
function RatingsCard({ lifetimeOrders }: { lifetimeOrders: number | null }) {
  const reviewsQ = useMyStoreReviews();
  const summary = reviewsQ.data?.summary;
  if (!summary || !summary.totalReviews) return null;
  const dist = summary.distribution ?? {};
  const max = Math.max(...[1, 2, 3, 4, 5].map((s) => Number(dist[String(s)] ?? 0)), 1);
  return (
    <Card style={{ marginBottom: space.md }}>
      <View style={{ flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: space.md }}>
        <T variant="micro" tone="muted">
          RATINGS
        </T>
        {lifetimeOrders != null ? (
          <T variant="caption" tone="muted">
            {lifetimeOrders} lifetime orders
          </T>
        ) : null}
      </View>
      <View style={{ flexDirection: 'row', gap: space.xl }}>
        <View style={{ alignItems: 'center', justifyContent: 'center', minWidth: space['5xl'] + space['4xl'] }}>
          <T variant="display">{Number(summary.averageRating).toFixed(1)}</T>
          <View style={{ flexDirection: 'row', gap: space.xs, marginTop: space.xs }}>
            {[1, 2, 3, 4, 5].map((s) => (
              <MaterialCommunityIcons
                key={s}
                name={Number(summary.averageRating) >= s - 0.25 ? 'star' : 'star-outline'}
                size={13}
                color={color.star}
              />
            ))}
          </View>
          <T variant="caption" tone="muted" style={{ marginTop: space.xs }}>
            {summary.totalReviews} rating{summary.totalReviews === 1 ? '' : 's'}
          </T>
        </View>
        <View style={{ flex: 1, justifyContent: 'center', gap: space.xs }}>
          {[5, 4, 3, 2, 1].map((s) => {
            const n = Number(dist[String(s)] ?? 0);
            return (
              <View key={s} style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
                <T variant="caption" tone="muted" style={{ width: space.md, textAlign: 'right' }}>
                  {s}
                </T>
                <View style={{ flex: 1, height: space.sm, borderRadius: radius.sm, backgroundColor: color.border.subtle, overflow: 'hidden' }}>
                  <View style={{ width: `${Math.round((n / max) * 100)}%`, height: space.sm, borderRadius: radius.sm, backgroundColor: n > 0 ? color.star : 'transparent' }} />
                </View>
                <T variant="caption" tone="muted" style={{ width: space.xl }}>
                  {n}
                </T>
              </View>
            );
          })}
        </View>
      </View>
    </Card>
  );
}

/**
 * Operational quality (Eats-Manager style): how fast the store answers, how
 * honest its prep quote is, and how often orders die. All real timestamps
 * from /vendor/analytics/ops — rows hide (not zero-fill) when there's no data.
 */
function OpsCard({ ops, period, stale }: { ops: any; period: number; stale?: boolean }) {
  if (!ops || !ops.placedOrders) return null;
  const prepDelta =
    ops.avgPrepMinutes != null && ops.avgQuotedPrepMinutes != null
      ? Math.round((ops.avgPrepMinutes - ops.avgQuotedPrepMinutes) * 10) / 10
      : null;
  return (
    <Card style={{ marginBottom: space.lg }}>
      <T variant="body" weight="bold">
        Operations · rolling {period}d
      </T>
      {stale ? (
        <T variant="caption" tone="muted" style={{ marginTop: space.xs }}>
          Showing the last loaded operations figures — refresh did not complete.
        </T>
      ) : null}
      <View style={{ flexDirection: 'row', gap: space.md, marginTop: space.md }}>
        {ops.acceptanceRate != null ? (
          <KpiTile icon="check-circle-outline" value={`${ops.acceptanceRate}%`} label="Acceptance" />
        ) : null}
        {ops.cancellationRate != null ? (
          <KpiTile icon="close-circle-outline" value={`${ops.cancellationRate}%`} label="Cancelled" />
        ) : null}
        {ops.avgAcceptMinutes != null ? (
          <KpiTile icon="timer-sand" value={`${ops.avgAcceptMinutes}m`} label="To accept" />
        ) : null}
      </View>
      {ops.avgPrepMinutes != null ? (
        <T variant="caption" tone="muted" style={{ marginTop: space.md }}>
          Prep runs ~{ops.avgPrepMinutes} min
          {ops.avgQuotedPrepMinutes != null ? ` against a ~${ops.avgQuotedPrepMinutes} min quote` : ''}
          {prepDelta != null && prepDelta > 2 ? ' — quote a little more time so customers aren’t kept waiting.' : '.'}
        </T>
      ) : null}
      {ops.vendorCancellations > 0 ? (
        <T variant="caption" tone="muted" style={{ marginTop: 4 }}>
          {ops.vendorCancellations} cancelled by the store — keep stock and hours current to protect your rating.
        </T>
      ) : null}
    </Card>
  );
}

const PERIODS = [7, 30, 90] as const;

function InsightMetric({ label, value, detail, badge }: { label: string; value: string; detail: string; badge?: ReactNode }) {
  return (
    <View style={{ flex: 1, borderRadius: radius.md, backgroundColor: color.surface.sunken, padding: space.md }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
        <T variant="micro" tone="muted">
          {label}
        </T>
        {badge ?? null}
      </View>
      <T variant="numM" numberOfLines={1} style={{ marginTop: space.xs }}>
        {value}
      </T>
      <T variant="caption" tone="muted" numberOfLines={2} style={{ marginTop: space.xs }}>
        {detail}
      </T>
    </View>
  );
}

/** MMG orders: the customer's payment (delivery fee included) landed in the
 *  store's MMG wallet — so the store hands the rider their fee in cash. This
 *  card is that ledger; "Mark paid" is the store's half of the dual confirm. */
function RiderFeesOwedCard() {
  const q = useVendorCashSettlements();
  const confirm = useConfirmVendorCashSettlement();
  // [MOB-046] A failed read used to produce an empty list, and an empty list
  // removed this card from the screen — which to a store owner is not an
  // outage, it is the absence of a debt. Money owed to a person is the last
  // thing that may be rendered by omission.
  const ledger = classifyOwedLedger({ isLoading: q.isLoading, error: q.error, data: q.data, fetched: q.isFetched });
  if (ledger.state === 'empty') return null;
  const rows: any[] = ledger.rows;
  return (
    <Card style={{ marginBottom: space.lg }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
        <T variant="caption" weight="bold" tone="muted" style={{ letterSpacing: 1 }}>
          YOU OWE RIDERS
        </T>
        <T variant="label" weight="bold">
          {ledger.owed == null ? '—' : money(ledger.owed)}
        </T>
      </View>
      {ledger.state !== 'ready' ? (
        <View style={{ paddingTop: space.md }}>
          <T variant="caption" tone="muted">
            {ledger.state === 'loading'
              ? 'Checking what you owe riders…'
              : "Swift can't reach this right now, so what you owe is not shown. It has not gone away — try again in a moment."}
          </T>
          {ledger.state === 'unavailable' ? (
            <PillButton
              label="Try again"
              variant="soft"
              size="sm"
              style={{ alignSelf: 'flex-start', marginTop: space.sm }}
              loading={q.isFetching}
              onPress={() => { void q.refetch(); }}
            />
          ) : null}
        </View>
      ) : null}
      <T variant="caption" tone="muted" style={{ marginTop: 2 }}>
        MMG orders — the delivery fee came to you with the customer&apos;s payment. Hand it to the rider in cash (usually at pickup).
      </T>
      {rows.map((r) => (
        <View key={r.id} style={{ paddingTop: space.md, marginTop: space.md, borderTopWidth: 1, borderTopColor: color.border.subtle }}>
          <View style={{ flexDirection: 'row', alignItems: 'center' }}>
            <View style={{ flex: 1 }}>
              <T variant="label" weight="semibold" numberOfLines={1}>
                {r.rider?.name || 'Rider'}
              </T>
              <T variant="caption" tone="muted">
                {r.orderNumber ? `#${r.orderNumber} · ` : ''}{fmtDate(r.createdAt)}
              </T>
            </View>
            <T variant="label" weight="bold" style={{ marginLeft: space.md }}>
              {money(r.amount)}
            </T>
          </View>
          {r.status === 'STORE_CONFIRMED' ? (
            <T variant="caption" tone="muted" style={{ marginTop: space.sm }}>
              You marked this paid — waiting for the rider to confirm.
            </T>
          ) : (
            <>
              {r.status === 'RIDER_CONFIRMED' ? (
                <T variant="caption" weight="semibold" tone="deep" style={{ marginTop: space.sm }}>
                  The rider confirmed receiving it — mark it paid to close it out.
                </T>
              ) : null}
              <PillButton
                label="Mark paid"
                variant="soft"
                size="sm"
                style={{ alignSelf: 'flex-start', marginTop: space.sm }}
                loading={confirm.isPending && confirm.variables === r.id}
                disabled={confirm.isPending}
                onPress={() => {
                  // [MOB-046] One tap used to record a cash payment with no
                  // confirmation and no visible failure. This is an attestation
                  // that money left the till and reached a named person: it
                  // names them and the amount, because a mis-tap on the wrong
                  // row is the same mistake as not paying at all.
                  const prompt = markPaidPrompt(r, money(r.amount));
                  Alert.alert(prompt.title, prompt.body, [
                    { text: 'Not yet', style: 'cancel' },
                    {
                      text: prompt.confirm,
                      onPress: () => confirm.mutate(r.id, {
                        onError: (mutationError) => Alert.alert('Not recorded', errorMessage(mutationError)),
                      }),
                    },
                  ]);
                }}
              />
            </>
          )}
        </View>
      ))}
    </Card>
  );
}

// Loyalty at a glance — how many customers came back (>=2 finished orders) and
// the repeat rate. Reads the MANAGER-only endpoint; the Insights tab is already
// manager-gated. Stays hidden until the store has finished orders.
function RepeatCustomersCard() {
  const q = useRepeatCustomers();
  const d: any = q.data;
  if (!d || (d.totalCustomers ?? 0) === 0) return null;
  return (
    <Card style={{ marginBottom: space.md }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
          <MaterialCommunityIcons name="account-heart" size={18} color={color.brand[500]} />
          <T variant="body" weight="semibold">
            Repeat customers
          </T>
        </View>
        <T variant="body" weight="bold">
          {d.repeatRate ?? 0}%
        </T>
      </View>
      <T variant="caption" tone="muted" style={{ marginTop: 4 }}>
        {d.repeatCustomers ?? 0} of {d.totalCustomers} customers came back — {d.totalOrders ?? 0} finished order{(d.totalOrders ?? 0) === 1 ? '' : 's'}.
      </T>
    </Card>
  );
}

export function VendorInsightsScreen() {
  const q = useVendorAnalytics();
  const readOnly = !!useVendorPreview((state) => state.previewType);
  // Signed short-lived link (the JWT can't ride an in-app browser).
  const statement = useMutation({
    mutationFn: async () => {
      const owner = requireAuthSessionSnapshot();
      const r = await vendorApi.salesStatement(owner);
      requireAuthSessionForPrincipal(owner);
      const path = r.data?.data?.path as string;
      // [WR-033] A mint that returns no path, or a link that can't open on
      // this phone, must FAIL the mutation — the error line below is the
      // honest signal; success used to be claimed silently either way.
      if (!path) throw new Error('Statement link missing from the response.');
      const opened = await openPayLink(`${API_URL}${path}`);
      requireAuthSessionForPrincipal(owner);
      if (opened === false) throw new Error("Couldn't open the statement on this phone.");
    },
  });
  // Fetch double the window so "vs the previous N days" comes from the same
  // real series (90 is the endpoint's max — no prior window at that depth).
  const [period, setPeriod] = useState<(typeof PERIODS)[number]>(7);
  const requestedDays = period === 90 ? 90 : period * 2;
  const revenueQ = useVendorRevenue(requestedDays);
  const refetchRevenue = revenueQ.refetch;
  const revenueBehindAnalytics = !readOnly && q.dataUpdatedAt > 0 && q.dataUpdatedAt > revenueQ.dataUpdatedAt;
  useEffect(() => {
    if (!readOnly && q.dataUpdatedAt > 0) void refetchRevenue();
  }, [readOnly, q.dataUpdatedAt, requestedDays, refetchRevenue]);
  const opsQ = useVendorOps(period);
  const popularQ = usePopularItems(8);
  const a: any = q.data ?? {};
  const v: any = a.vendor ?? {};
  const daily = reconciledRevenueDays(revenueQ.data, a, requestedDays);
  const shownDays = readOnly ? Math.min(period, daily.length) : period;
  const hasFullWindow = readOnly ? shownDays > 0 : hasTrailingGuyanaDays(daily, period);
  const w = windowTotals(daily, hasFullWindow ? shownDays : 0);
  const aovCur = w.cur.orders != null && w.cur.orders > 0 ? w.cur.revenue / w.cur.orders : null;
  const aovPrev = w.prev?.orders != null && w.prev.orders > 0 ? w.prev.revenue / w.prev.orders : null;
  const acceptanceRate = numericFact(opsQ.data?.acceptanceRate);
  const cancellationRate = numericFact(opsQ.data?.cancellationRate);
  const placedOrders = numericFact(opsQ.data?.placedOrders);
  const primaryLoading = (q.isLoading && !q.data) || (revenueQ.isLoading && !revenueQ.data) || (revenueBehindAnalytics && !revenueQ.isError);
  const primaryError = (q.isError && !q.data) || (revenueQ.isError && (!revenueQ.data || revenueBehindAnalytics));
  const showingStale = (q.isError && !!q.data) || (revenueQ.isError && !!revenueQ.data);
  const refreshing = q.isRefetching || revenueQ.isRefetching || opsQ.isRefetching || popularQ.isRefetching;
  const opsDetail = readOnly
    ? 'Not included in sample'
    : opsQ.isLoading
      ? 'Loading this range'
      : opsQ.isError
        ? opsQ.data
          ? 'Last loaded · refresh failed'
          : 'Unavailable — pull to retry'
        : placedOrders === 0
          ? 'No placed orders'
          : placedOrders == null
            ? 'No rate reported'
            : `${placedOrders} placed order${placedOrders === 1 ? '' : 's'}`;
  const retryPrimary = () => {
    q.refetch();
    revenueQ.refetch();
  };

  return (
    <Screen>
      <TabHeader title="Insights" eyebrow={readOnly ? 'PREVIEW · SAMPLE DATA' : 'MONEY EARNED · GYD'} />
      <ScrollView
        contentContainerStyle={{ paddingHorizontal: GUTTER, paddingBottom: space['3xl'] }}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => {
              q.refetch();
              revenueQ.refetch();
              opsQ.refetch();
              popularQ.refetch();
            }}
            tintColor={color.brand[500]}
          />
        }
      >
        <View style={{ marginBottom: space.lg }}>
          <T variant="heading">Revenue at a glance</T>
          <T variant="label" tone="muted" style={{ marginTop: space.xs }}>
            Completed-order revenue. Swift never holds order money; cash and MMG settle peer-to-peer along the handoff.
          </T>
          {/* [Wave 3 · ref 21] A range switch is a LENS — one value is always
              selected — so it rides Segmented (raised chip on a sunken track),
              not a row of ChoiceChips. Predates the primitive; no longer. */}
          <Segmented
            options={PERIODS.map((p) => ({ key: String(p), label: `${p}d` }))}
            value={String(period)}
            onChange={(key) => setPeriod(Number(key) as (typeof PERIODS)[number])}
            style={{ marginTop: space.md }}
          />
        </View>

        {primaryLoading ? (
          <LoadingBlock />
        ) : primaryError ? (
          // [WR-032] Failed analytics must never render as zero KPIs — a zero
          // is a business fact, not a connection state.
          <ErrorState message="We couldn't load this revenue range. Check your connection and try again." onRetry={retryPrimary} />
        ) : !hasFullWindow ? (
          <ErrorState message="This revenue range is incomplete, so we won't present a partial total as the full period." onRetry={retryPrimary} />
        ) : (
          <>
            <Card style={{ marginBottom: space.lg, padding: space.xl }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: space.md }}>
                <T variant="micro" tone="muted">
                  REVENUE · {readOnly ? `SAMPLE ${shownDays} DAYS` : `LAST ${period} DAYS`}
                </T>
                {w.prev ? <DeltaBadge cur={w.cur.revenue} prev={w.prev.revenue} /> : null}
              </View>
              <T variant="displayXl" numberOfLines={1} style={{ marginTop: space.sm }}>
                {money(w.cur.revenue)}
              </T>
              <T variant="label" tone="muted" style={{ marginTop: space.xs }}>
                {w.cur.orders == null
                  ? 'Order count is not included in this sample.'
                  : `${w.cur.orders} completed order${w.cur.orders === 1 ? '' : 's'} in this range.`}
              </T>
              {showingStale ? (
                <T variant="caption" tone="muted" style={{ marginTop: space.sm }}>
                  Showing the last loaded figures — refresh did not complete.
                </T>
              ) : null}
              {w.curDaily.length > 0 ? <RevenueChart daily={w.curDaily} /> : null}
              {w.cur.revenue === 0 ? (
                <T variant="caption" tone="muted" style={{ marginTop: space.md }}>
                  No completed-order revenue landed in this range.
                </T>
              ) : null}
              {w.prev ? (
                <T variant="caption" tone="muted" style={{ marginTop: space.md }}>
                  Change against the previous {period} days.
                </T>
              ) : period === 90 && !readOnly ? (
                <T variant="caption" tone="muted" style={{ marginTop: space.md }}>
                  Prior-period comparison is available at 7 and 30 days.
                </T>
              ) : null}
            </Card>

            {/* [ref 21] The AOV delta rides IN its tile. Acceptance/Cancelled
                stay badge-less on purpose: the server sends no previous-window
                ops rates — registered as a server follow-up, never invented. */}
            <View style={{ flexDirection: 'row', gap: space.sm, marginBottom: space.lg }}>
              <InsightMetric
                label="AVG ORDER"
                value={aovCur == null ? '—' : money(aovCur)}
                detail={aovCur == null ? 'Needs order count' : `${shownDays}d completed`}
                badge={aovCur != null && aovPrev != null ? <DeltaBadge cur={aovCur} prev={aovPrev} /> : undefined}
              />
              <InsightMetric
                label="ACCEPTANCE"
                value={acceptanceRate == null ? '—' : `${acceptanceRate}%`}
                detail={opsDetail}
              />
              <InsightMetric
                label="CANCELLED"
                value={cancellationRate == null ? '—' : `${cancellationRate}%`}
                detail={opsDetail}
              />
            </View>

            {popularQ.isLoading && !popularQ.data ? (
              <Card style={{ marginBottom: space.md }}>
                <T variant="label" tone="muted">Loading item ranking…</T>
              </Card>
            ) : popularQ.isError && !popularQ.data ? (
              <Card style={{ marginBottom: space.md }}>
                <T variant="label" tone="muted">Item ranking is unavailable right now.</T>
                <PillButton label="Retry" size="md" variant="soft" style={{ marginTop: space.sm }} onPress={() => popularQ.refetch()} />
              </Card>
            ) : (
              <>
                {popularQ.isError ? (
                  <T variant="caption" tone="muted" style={{ marginBottom: space.sm }}>
                    Showing the last loaded item ranking — refresh did not complete.
                  </T>
                ) : null}
                <TopItemsCard items={Array.isArray(popularQ.data) ? popularQ.data : []} sample={readOnly} />
              </>
            )}

            <T variant="heading" style={{ marginTop: space.md, marginBottom: space.md }}>
              Business health
            </T>
            {/* MMG cash ledger — delivery fees owed to riders (renders only when non-empty) */}
            <RiderFeesOwedCard />
            <OpsCard ops={opsQ.data} period={period} stale={opsQ.isError} />
            <BusyHoursCard />
            <RepeatCustomersCard />
            <VendorStandingSection />
            <RatingsCard lifetimeOrders={numericFact(v.totalOrders)} />
            <ReviewsCard />
            <View style={{ flexDirection: 'row', gap: space.md }}>
              <KpiTile icon="silverware-fork-knife" value={numericFact(a.activeMenuItems) == null ? '—' : String(a.activeMenuItems)} label="Active items" />
              <KpiTile icon="calendar-month" value={numericFact(a.month?.orders) == null ? '—' : String(a.month.orders)} label="Orders / month" />
            </View>

            {/* Printable 30-day sales statement (marketplace §12) — what a
                store shows their accountant. Opens in the in-app browser. */}
            {!readOnly ? (
              <>
                <PillButton
                  label="Get sales statement"
                  variant="outline"
                  size="md"
                  style={{ marginTop: space.lg }}
                  loading={statement.isPending}
                  onPress={() => statement.mutate()}
                />
                {statement.isError ? (
                  <T variant="caption" tone="error" center style={{ marginTop: space.sm }}>
                    Couldn’t open the statement — try again.
                  </T>
                ) : null}
              </>
            ) : null}
            {/* [ref 21] The reference's own closing line — and this screen's
                actual law (reconciledRevenueDays + the partial-window refusal
                above are what make it true). */}
            <T variant="caption" tone="faint" center style={{ marginTop: space.xl }}>
              Reconciled numbers only — a beautiful wrong number is still a lie.
            </T>
          </>
        )}
      </ScrollView>
    </Screen>
  );
}
