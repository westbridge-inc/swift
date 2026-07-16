/** @jsxImportSource react */
import React, { useEffect, useState } from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather, MaterialCommunityIcons } from '@expo/vector-icons';
import { space } from '@swift/ui';
import { LoadingBlock, PillButton, T } from '../../../kit';
import { useJobHistory, useMoverKind } from '../../../hooks';
import { money } from '../../../lib/money';
import { JobStatusPill, RoutePair, whenLabel } from '../shared';
import { dk, DCard, DHeader } from '../dark';

/** Job history in the earner app's dark language (Phase E-lite). */

// Driver rides are status-filterable server-side; rider history is already
// terminal-only (delivered/completed/cancelled), so riders just get the list.
const DRIVER_FILTERS: { label: string; status?: string }[] = [
  { label: 'All' },
  { label: 'Completed', status: 'COMPLETED' },
  { label: 'Cancelled', status: 'CANCELLED' },
];

function DarkChip({ label, selected, onPress }: { label: string; selected: boolean; onPress: () => void }) {
  return (
    <Pressable onPress={onPress}>
      {({ pressed }) => (
        <View
          style={{
            height: 38,
            paddingHorizontal: space.lg,
            borderRadius: 9999,
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: selected ? dk.accent : dk.card,
            borderWidth: 1,
            borderColor: selected ? dk.accent : dk.line,
            opacity: pressed ? 0.8 : 1,
          }}
        >
          <T variant="label" weight={selected ? 'bold' : 'semibold'} style={{ color: selected ? '#fff' : dk.muted }}>
            {label}
          </T>
        </View>
      )}
    </Pressable>
  );
}

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
    <DCard style={{ marginBottom: space.md }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
        <T variant="caption" style={{ color: dk.muted }}>
          {whenLabel(job.deliveredAt ?? job.placedAt ?? job.createdAt)}
        </T>
        <JobStatusPill status={job.status} dark />
      </View>
      <View style={{ marginTop: space.md }}>
        <RoutePair pickup={pickup ?? 'Pickup'} dropoff={dropoff} muted dark />
      </View>
      {items.length > 0 ? (
        <T variant="caption" numberOfLines={1} style={{ color: dk.muted, marginTop: space.sm }}>
          {items.map((i) => `${i.quantity}× ${i.name}`).join(' · ')}
        </T>
      ) : null}
      <View style={{ flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', marginTop: space.sm }}>
        <T variant="caption" style={{ color: dk.muted }}>
          {meta.join(' · ')}
        </T>
        <T variant="body" weight="bold" style={{ color: dk.text }}>
          {money(amount)}
        </T>
      </View>
    </DCard>
  );
}

export function JobHistoryScreen({ navigation }: any) {
  const insets = useSafeAreaInsets();
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
    <View style={{ flex: 1, backgroundColor: dk.bg, paddingTop: insets.top }}>
      <DHeader title={isDriver ? 'Your trips' : 'Your jobs'} onBack={() => navigation?.goBack?.()} />
      {isDriver ? (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={{ flexGrow: 0, marginBottom: space.md }}
          contentContainerStyle={{ paddingHorizontal: space['2xl'], gap: space.md }}
        >
          {DRIVER_FILTERS.map((f, i) => (
            <DarkChip
              key={f.label}
              label={f.label}
              selected={i === filter}
              onPress={() => {
                setFilter(i);
                setPage(1);
              }}
            />
          ))}
        </ScrollView>
      ) : null}

      <ScrollView contentContainerStyle={{ paddingHorizontal: space['2xl'], paddingBottom: space['3xl'] }} showsVerticalScrollIndicator={false}>
        {total > 0 ? (
          <T variant="caption" weight="semibold" style={{ color: dk.muted, marginBottom: space.md }}>
            {total} {isDriver ? 'trip' : 'job'}
            {total === 1 ? '' : 's'}
          </T>
        ) : null}

        {q.isLoading && rows.length === 0 ? (
          <LoadingBlock />
        ) : rows.length === 0 ? (
          <View style={{ alignItems: 'center', paddingVertical: space['3xl'] }}>
            <MaterialCommunityIcons name="inbox-outline" size={34} color={dk.faint} />
            <T variant="body" weight="bold" style={{ color: dk.text, marginTop: space.md }}>
              {isDriver ? 'No trips yet' : 'No jobs yet'}
            </T>
            <T variant="label" center style={{ color: dk.muted, marginTop: space.sm, paddingHorizontal: space['2xl'] }}>
              Finished jobs build your history here — go online to start earning.
            </T>
          </View>
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
                <Feather name="check-circle" size={13} color={dk.faint} />
                <T variant="caption" style={{ color: dk.muted }}>
                  That&apos;s everything
                </T>
              </View>
            )}
          </>
        )}
      </ScrollView>
    </View>
  );
}
