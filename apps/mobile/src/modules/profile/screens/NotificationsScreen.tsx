/** @jsxImportSource react */
import React from 'react';
import { FlatList, View } from 'react-native';
import { color, space } from '@swift/ui';
import { useNotifications } from '../../../hooks/customer';
import { Card, EmptyState, ErrorState, Header, IconChip, LoadingBlock, Screen, T } from '../../../kit';

// Kit Notification (56): stacked rows with icon chips; unread carries a dot.
const ICON_FOR: Record<string, React.ComponentProps<typeof IconChip>['icon']> = {
  ORDER: 'shopping-bag',
  PROMO: 'tag',
  SYSTEM: 'info',
  PAYMENT: 'dollar-sign',
};

export function NotificationsScreen() {
  const notifications = useNotifications<any>();
  const rows: any[] = Array.isArray(notifications.data)
    ? notifications.data
    : (notifications.data?.notifications ?? []);

  return (
    <Screen>
      <Header title="Notification" />
      {notifications.isLoading ? (
        <LoadingBlock />
      ) : notifications.isError ? (
        <ErrorState onRetry={() => notifications.refetch()} />
      ) : rows.length === 0 ? (
        <EmptyState icon="bell" title="Nothing yet" body="Order updates and promos will land here." />
      ) : (
        <FlatList
          data={rows}
          keyExtractor={(n, i) => n.id ?? String(i)}
          contentContainerStyle={{ padding: space['2xl'], gap: space.md }}
          renderItem={({ item: n }) => (
            <Card style={{ flexDirection: 'row', alignItems: 'center', gap: space.md, padding: space.md }}>
              <IconChip icon={ICON_FOR[n.type] ?? 'bell'} />
              <View style={{ flex: 1, gap: 2 }}>
                <T variant="body" weight={n.isRead ? 'regular' : 'semibold'} numberOfLines={1}>
                  {n.title ?? 'Update'}
                </T>
                <T variant="caption" tone="muted" numberOfLines={2}>
                  {n.body ?? n.message ?? ''}
                </T>
                <T variant="caption" tone="faint">
                  {n.createdAt ? new Date(n.createdAt).toLocaleString() : ''}
                </T>
              </View>
              {!n.isRead ? <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: color.brand[500] }} /> : null}
            </Card>
          )}
        />
      )}
    </Screen>
  );
}
