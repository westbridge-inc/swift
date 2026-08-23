/** @jsxImportSource react */
import React, { useEffect, useState } from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import { Feather, MaterialCommunityIcons } from '@expo/vector-icons';
import { color, space } from '@swift/ui';
import { Card, Chip, EmptyState, ErrorState, LoadingBlock, PillButton, Screen, T } from '../../../kit';
import { useVendorOrderHistory, useVendorProfile } from '../../../hooks/vendorops';
import { money } from '../../../lib/money';
import { GUTTER, InlineInput, OrderStatusPill, SubHeader, fmtWhen } from '../shared';

const FILTERS: { label: string; status?: string }[] = [
  { label: 'All' },
  { label: 'Delivered', status: 'DELIVERED' },
  { label: 'Completed', status: 'COMPLETED' },
  { label: 'Cancelled', status: 'CANCELLED' },
];

function HistoryRow({ order, onPress }: { order: any; onPress: () => void }) {
  const items = order.itemCount ?? order.items?.length ?? 0;
  return (
    <Pressable onPress={onPress}>
      {({ pressed }) => (
        <Card style={{ marginBottom: space.md, opacity: pressed ? 0.85 : 1 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
            <T variant="body" weight="bold" numberOfLines={1} style={{ flexShrink: 1, paddingRight: space.md }}>
              {order.orderNumber ? `#${order.orderNumber}` : 'Order'}
            </T>
            <OrderStatusPill status={order.status} />
          </View>
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 4 }}>
            <T variant="caption" tone="muted" numberOfLines={1} style={{ flexShrink: 1, paddingRight: space.md }}>
              {fmtWhen(order.placedAt)}
              {items ? ` · ${items} item${items === 1 ? '' : 's'}` : ''}
              {[order.customer?.firstName, order.customer?.lastName].filter(Boolean).length
                ? ` · ${[order.customer?.firstName, order.customer?.lastName].filter(Boolean).join(' ')}`
                : ''}
            </T>
            <T variant="label" weight="semibold">
              {money(order.totalAmount ?? order.total)}
            </T>
          </View>
        </Card>
      )}
    </Pressable>
  );
}

export function VendorOrderHistoryScreen({ navigation }: any) {
  const { store } = useVendorProfile();
  const [filter, setFilter] = useState(0);
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [rows, setRows] = useState<any[]>([]);

  // Debounce free typing into the server-side search param.
  useEffect(() => {
    const t = setTimeout(() => {
      setSearch(searchInput.trim());
      setPage(1);
    }, 400);
    return () => clearTimeout(t);
  }, [searchInput]);

  const status = FILTERS[filter]?.status;
  const q = useVendorOrderHistory({ status, search: search || undefined, page });

  // Accumulate pages; any filter change resets to page 1 and replaces the list.
  useEffect(() => {
    if (!q.data) return;
    setRows((prev) => (q.data!.meta.page === 1 ? q.data!.data : [...prev, ...q.data!.data]));
  }, [q.data]);

  const total = q.data?.meta.total ?? 0;
  const hasMore = rows.length < total;

  return (
    <Screen>
      <SubHeader title="Order history" navigation={navigation} />
      <View style={{ paddingHorizontal: GUTTER, marginBottom: space.md }}>
        <InlineInput value={searchInput} onChangeText={setSearchInput} placeholder="Search order # or customer" autoCapitalize="none" />
      </View>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={{ flexGrow: 0, marginBottom: space.md }}
        contentContainerStyle={{ paddingHorizontal: GUTTER, gap: space.md }}
      >
        {FILTERS.map((f, i) => (
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

      <ScrollView contentContainerStyle={{ paddingHorizontal: GUTTER, paddingBottom: space['3xl'] }} showsVerticalScrollIndicator={false}>
        {store?.name ? (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: space.md }}>
            <MaterialCommunityIcons name="storefront-outline" size={14} color={color.brand[500]} />
            <T variant="caption" weight="semibold" tone="muted">
              {store.name} · {total} order{total === 1 ? '' : 's'}
            </T>
          </View>
        ) : null}

        {q.isLoading && rows.length === 0 ? (
          <LoadingBlock />
        ) : q.isError && rows.length === 0 ? (
          // [WR-032] An outage is not "No orders yet".
          <ErrorState message="We couldn't load your history. Check your connection and try again." onRetry={() => q.refetch()} />
        ) : rows.length === 0 ? (
          <EmptyState
            icon="inbox"
            title={search || status ? 'Nothing matches' : 'No orders yet'}
            body={search || status ? 'Try a different filter or search.' : 'Completed and cancelled orders build your history here.'}
          />
        ) : (
          <>
            {rows.map((o) => (
              <HistoryRow key={o.id} order={o} onPress={() => navigation.navigate('VendorOrderDetail', { orderId: o.id, orderNumber: o.orderNumber })} />
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
