/** @jsxImportSource react */
import React, { useEffect, useState } from 'react';
import { ScrollView, View } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { color, fontSize, radius, space } from '@swift/ui';
import { Card, Chip, EmptyState, ErrorState, Header, LoadingBlock, PillButton, Screen, T } from '../../../kit';
import { useJobHistory, useMoverKind } from '../../../hooks';
import { money } from '../../../lib/money';
import { JobStatusPill, RoutePair, whenLabel } from '../shared';
import {
  historyEarningAmount,
  historyItemSummary,
  historyTip,
  isCompletedStatus,
  mergeUniqueRows,
  moneyOrDash,
  serverCount,
  serverDate,
  serverNumber,
  serverRecord,
  serverRecords,
  serverText,
} from '../earner-data';

// Driver rides are status-filterable server-side; rider history is already
// terminal-only (delivered/completed/cancelled), so riders just get the list.
const DRIVER_FILTERS: { label: string; status?: string }[] = [
  { label: 'All' },
  { label: 'Completed', status: 'DELIVERED' },
  { label: 'Cancelled', status: 'CANCELLED' },
];

function JobRow({ job, isDriver }: { job: Record<string, unknown>; isDriver: boolean }) {
  const pickup = isDriver
    ? serverText(job['taxiPickupAddress'])
    : serverText(serverRecord(job['vendor'])?.['name']) ?? serverText(job['pickupAddress']);
  const dropoff = isDriver
    ? serverText(job['taxiDropoffAddress'])
    : serverText(job['deliveryAddress']) ?? serverText(job['dropoffAddress']);
  const amount = historyEarningAmount(job, isDriver);
  const tip = historyTip(job);
  const items = historyItemSummary(job['items']);
  const status = serverText(job['status'])?.toUpperCase();
  const displayedStatus = isDriver && status === 'DELIVERED' ? 'COMPLETED' : status;
  // Neither history endpoint exposes a cancellation event timestamp. Only
  // show the completion timestamp the response can actually substantiate.
  const happenedAt = isCompletedStatus(status) ? serverDate(job['deliveredAt']) : undefined;
  const distance = isDriver ? serverNumber(job['taxiDistance']) : undefined;
  const duration = isDriver ? serverNumber(job['taxiDuration']) : undefined;
  const travelParts = [
    distance == null ? undefined : `${distance.toFixed(1)} km`,
    duration == null ? undefined : `${Math.round(duration)} min`,
  ].filter((part): part is string => !!part);
  const travel = travelParts.length ? `Est. ${travelParts.join(' · ')}` : undefined;

  return (
    <Card style={{ marginBottom: space.md }}>
      {happenedAt || displayedStatus ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
          {happenedAt ? <T variant="caption" tone="muted">{whenLabel(happenedAt)}</T> : <View />}
          {displayedStatus ? <JobStatusPill status={displayedStatus} /> : null}
        </View>
      ) : null}
      {pickup ? (
        <View style={{ marginTop: space.md }}>
          <RoutePair pickup={pickup} dropoff={dropoff} muted />
        </View>
      ) : dropoff ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: space.md }}>
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
            <Feather name="map-pin" size={fontSize.base} color={color.text.secondary} />
          </View>
          <T variant="label" weight="semibold" numberOfLines={1} style={{ flex: 1, marginLeft: space.sm }}>
            {dropoff}
          </T>
        </View>
      ) : null}
      {items ? (
        <T variant="caption" tone="muted" numberOfLines={1} style={{ marginTop: space.sm }}>
          {items}
        </T>
      ) : null}
      <View style={{ flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between', gap: space.md, marginTop: space.sm }}>
        <View style={{ flex: 1 }}>
          {travel ? <T variant="caption" tone="muted">{travel}</T> : null}
          {tip != null ? (
            <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: space.xs }}>
              <T variant="caption" tone="muted">Tip</T>
              <T variant="numM">{money(tip)}</T>
            </View>
          ) : null}
        </View>
        <T variant="numM">{moneyOrDash(amount)}</T>
      </View>
    </Card>
  );
}

export function JobHistoryScreen({ navigation: _navigation }: any) {
  const mover = useMoverKind();
  const { kind } = mover;
  const isDriver = kind === 'DRIVER';
  const [filter, setFilter] = useState(0);
  const [page, setPage] = useState(1);
  const [loaded, setLoaded] = useState<{
    key: string;
    rows: Record<string, unknown>[];
    total?: number;
    hasNext?: boolean;
    valid?: boolean;
  }>({ key: '', rows: [] });

  const status = isDriver ? DRIVER_FILTERS[filter]?.status : undefined;
  const q = useJobHistory(kind, page, status);
  const historyKey = `${kind ?? 'none'}:${status ?? 'all'}`;

  useEffect(() => {
    if (q.isError || !q.data || q.isPlaceholderData) return;
    const payload = serverRecord(q.data);
    const meta = serverRecord(payload?.['meta']);
    const responsePage = serverCount(meta?.['page']);
    if ((responsePage != null && responsePage !== page) || (responsePage == null && page !== 1)) {
      setLoaded((previous) => ({
        key: historyKey,
        rows: previous.key === historyKey ? previous.rows : [],
        total: previous.key === historyKey ? previous.total : undefined,
        hasNext: previous.key === historyKey ? previous.hasNext : undefined,
        valid: false,
      }));
      return;
    }
    const rawIncoming = payload?.['data'];
    const incoming = serverRecords(rawIncoming);
    const valid = Array.isArray(rawIncoming)
      && incoming.length === rawIncoming.length
      && incoming.every((row) => !!serverText(row['id']));
    const total = serverCount(meta?.['total']);
    const hasNext = typeof meta?.['hasNext'] === 'boolean' ? meta['hasNext'] : undefined;
    setLoaded((previous) => {
      const base = responsePage === 1 || previous.key !== historyKey ? [] : previous.rows;
      return {
        key: historyKey,
        rows: mergeUniqueRows(base, valid ? incoming : []),
        total,
        hasNext,
        valid,
      };
    });
  }, [historyKey, page, q.data, q.isError, q.isPlaceholderData]);

  const current = loaded.key === historyKey
    ? loaded
    : { key: historyKey, rows: [], total: undefined, hasNext: undefined, valid: undefined };
  const { rows, total, hasNext, valid } = current;
  const hasMore = hasNext === true
    ? total == null || rows.length < total
    : hasNext == null && total != null && rows.length < total;
  const atEnd = hasNext === false
    ? total == null || rows.length >= total
    : hasNext == null && total != null && rows.length >= total;
  const emptyResponseContradictsMeta = valid === true
    && rows.length === 0
    && (hasNext === true || (total != null && total > 0));
  const confirmedEmpty = valid === true
    && rows.length === 0
    && !emptyResponseContradictsMeta;

  return (
    <Screen>
      <Header title={isDriver ? 'Your trips' : 'Your jobs'} />
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
      ) : (
        <>
          {isDriver ? (
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              style={{ flexGrow: 0, marginBottom: space.md }}
              contentContainerStyle={{ paddingHorizontal: space['2xl'], gap: space.md }}
            >
              {DRIVER_FILTERS.map((item, index) => (
                <Chip
                  key={item.label}
                  label={item.label}
                  selected={index === filter}
                  onPress={() => {
                    setFilter(index);
                    setPage(1);
                  }}
                />
              ))}
            </ScrollView>
          ) : null}

          <ScrollView
            contentContainerStyle={{ paddingHorizontal: space['2xl'], paddingBottom: space['3xl'] }}
            showsVerticalScrollIndicator={false}
          >
            {valid === true && total != null ? (
              <T variant="caption" weight="semibold" tone="muted" style={{ marginBottom: space.md }}>
                {total} {isDriver ? (total === 1 ? 'trip' : 'trips') : (total === 1 ? 'job' : 'jobs')}
              </T>
            ) : null}

            {(q.isLoading || q.isFetching) && rows.length === 0 ? (
              <LoadingBlock />
            ) : (q.isError || valid === false || emptyResponseContradictsMeta)
              && rows.length === 0 ? (
              <ErrorState
                message={q.isError
                  ? "We couldn't load your history. Check your connection and try again."
                  : "Your history wasn't included in the response. Try again."}
                onRetry={() => q.refetch()}
              />
            ) : confirmedEmpty ? (
              <EmptyState
                icon="inbox"
                title={isDriver ? 'No trips yet' : 'No jobs yet'}
                body={isDriver
                  ? 'Finished trips build your history here — go online to start earning.'
                  : 'Finished jobs build your history here — go online to start earning.'}
              />
            ) : (
              <>
                {rows.map((job, index) => (
                  <JobRow
                    key={serverText(job['id']) ?? `${historyKey}-${index}`}
                    job={job}
                    isDriver={isDriver}
                  />
                ))}
                {q.isError || valid === false ? (
                  <Card style={{ marginTop: space.sm }}>
                    <T variant="caption" tone="error" center>
                      {q.isError
                        ? 'We couldn\'t load the next page.'
                        : 'The next page wasn\'t included in the response.'}
                    </T>
                    <PillButton
                      label="Try again"
                      variant="outline"
                      size="md"
                      onPress={() => q.refetch()}
                      style={{ marginTop: space.sm }}
                    />
                  </Card>
                ) : hasMore ? (
                  <PillButton
                    label={q.isFetching
                      ? 'Loading…'
                      : total != null
                        ? `Load more (${rows.length} of ${total})`
                        : `Load more (${rows.length} loaded)`}
                    variant="soft"
                    size="md"
                    disabled={q.isFetching}
                    onPress={() => setPage((currentPage) => currentPage + 1)}
                    style={{ marginTop: space.sm }}
                  />
                ) : atEnd ? (
                  <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: space.xs, marginTop: space.md }}>
                    <Feather name="check-circle" size={fontSize.xs} color={color.text.muted} />
                    <T variant="caption" tone="muted">That&apos;s everything</T>
                  </View>
                ) : null}
              </>
            )}
          </ScrollView>
        </>
      )}
    </Screen>
  );
}
