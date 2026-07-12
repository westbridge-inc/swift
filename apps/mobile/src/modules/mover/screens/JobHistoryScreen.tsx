/** @jsxImportSource react */
import React, { useEffect, useState } from 'react';
import { ScrollView, View } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { color, space } from '@swift/ui';
import { Card, Chip, EmptyState, Header, LoadingBlock, PillButton, Screen, T } from '../../../kit';
import { useJobHistory, useMoverKind } from '../../../hooks';
import { money } from '../../../lib/money';
import { JobStatusPill, RoutePair, whenLabel } from '../shared';

// Driver rides are status-filterable server-side; rider history is already
// terminal-only (delivered/completed/cancelled), so riders just get the list.
const DRIVER_FILTERS: { label: string; status?: string }[] = [
  { label: 'All' },
  { label: 'Completed', status: 'COMPLETED' },
  { label: 'Cancelled', status: 'CANCELLED' },
];

function JobRow({ job, isDriver }: { job: any; isDriver: boolean }) {
  const pickup = isDriver ? job.taxiPickupAddress : job.vendor?.name ?? job.pickupAddress;
  const dropoff = isDriver ? job.taxiDropoffAddress : job.deliveryAddress ?? job.dropoffAddress;
  const amount = Number(job.totalAmount ?? job.taxiFareTotal ?? 0);
  const items: any[] = job.items ?? [];
  const meta: string[] = [];
  if (isDriver && job.taxiDistance != null) meta.push(`${Number(job.taxiDistance).toFixed(1)} km`);
  if (isDriver && job.taxiDuration != null) meta.push(`${Math.round(Number(job.taxiDuration))} min`);
  if (Number(job.tipAmount) > 0) meta.push(`tip ${money(job.tipAmount)}`);
  return (
    <Card style={{ marginBottom: space.md }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
        <T variant="caption" tone="muted">
          {whenLabel(job.deliveredAt ?? job.placedAt ?? job.createdAt)}
        </T>
        <JobStatusPill status={job.status} />
      </View>
      <View style={{ marginTop: space.md }}>
        <RoutePair pickup={pickup ?? 'Pickup'} dropoff={dropoff} muted />
      </View>
      {items.length > 0 ? (
        <T variant="caption" tone="muted" numberOfLines={1} style={{ marginTop: space.sm }}>
          {items.map((i) => `${i.quantity}× ${i.name}`).join(' · ')}
        </T>
      ) : null}
      <View style={{ flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', marginTop: space.sm }}>
        <T variant="caption" tone="muted">
          {meta.join(' · ')}
        </T>
        <T variant="body" weight="bold">
          {money(amount)}
        </T>
      </View>
    </Card>
  );
}

export function JobHistoryScreen({ navigation: _navigation }: any) {
  const { kind } = useMoverKind();
  const isDriver = kind === 'DRIVER';
  const [filter, setFilter] = useState(0);
  const [page, setPage] = useState(1);
  const [rows, setRows] = useState<any[]>([]);

  const status = isDriver ? DRIVER_FILTERS[filter]?.status : undefined;
  const q = useJobHistory(kind, page, status);

  useEffect(() => {
    if (!q.data) return;
    setRows((prev) => (q.data!.meta.page === 1 ? q.data!.data : [...prev, ...q.data!.data]));
  }, [q.data]);

  const total = q.data?.meta.total ?? 0;
  const hasMore = rows.length < total;

  return (
    <Screen>
      <Header title={isDriver ? 'Your trips' : 'Your jobs'} />
      {isDriver ? (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={{ flexGrow: 0, marginBottom: space.md }}
          contentContainerStyle={{ paddingHorizontal: space['2xl'], gap: space.md }}
        >
          {DRIVER_FILTERS.map((f, i) => (
            <Chip
              key={f.label}
              label={f.label}
              selected={i === filter}
              onPress={() => {
                setFilter(i);
                setPage(1);
              }}
              style={{ height: 38, paddingHorizontal: space.lg }}
            />
          ))}
        </ScrollView>
      ) : null}

      <ScrollView contentContainerStyle={{ paddingHorizontal: space['2xl'], paddingBottom: space['3xl'] }} showsVerticalScrollIndicator={false}>
        {total > 0 ? (
          <T variant="caption" weight="semibold" tone="muted" style={{ marginBottom: space.md }}>
            {total} {isDriver ? 'trip' : 'job'}
            {total === 1 ? '' : 's'}
          </T>
        ) : null}

        {q.isLoading && rows.length === 0 ? (
          <LoadingBlock />
        ) : rows.length === 0 ? (
          <EmptyState
            icon="inbox"
            title={isDriver ? 'No trips yet' : 'No jobs yet'}
            body="Finished jobs build your history here — go online to start earning."
          />
        ) : (
          <>
            {rows.map((j) => (
              <JobRow key={j.id} job={j} isDriver={isDriver} />
            ))}
            {hasMore ? (
              <PillButton
                label={q.isFetching ? 'Loading…' : `Load more (${rows.length} of ${total})`}
                variant="soft"
                size="md"
                disabled={q.isFetching}
                onPress={() => setPage((p) => p + 1)}
                style={{ marginTop: space.sm }}
              />
            ) : (
              <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, marginTop: space.md }}>
                <Feather name="check-circle" size={13} color={color.text.muted} />
                <T variant="caption" tone="muted">
                  That&apos;s everything
                </T>
              </View>
            )}
          </>
        )}
      </ScrollView>
    </Screen>
  );
}
