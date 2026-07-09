import React, { useMemo } from 'react';
import { FlatList, View } from 'react-native';
import { Image } from 'expo-image';
import { Feather } from '@expo/vector-icons';
import { useNavigation } from '@react-navigation/native';
import { color, space } from '@swift/ui';
import { useOrders } from '../../../hooks/customer';
import { useAuthStore } from '../../../stores/authStore';
import { Card, EmptyState, ErrorState, LoadingBlock, Screen, T } from '../../../kit';

const ACTIVE = new Set(['RIDER_ASSIGNED', 'PICKED_UP', 'READY']);
const RECENT = new Set(['DELIVERED', 'COMPLETED']);

// Kit Chat List (40). Swift chat is order-scoped (customer ↔ rider), so the
// inbox is derived from orders that actually have a rider — no invented
// conversations endpoint.
export function ChatListScreen() {
  const navigation = useNavigation<any>();
  const { isAuthenticated, promptLogin } = useAuthStore();
  const orders = useOrders<any>();

  const rows = useMemo(() => {
    const all: any[] = Array.isArray(orders.data) ? orders.data : (orders.data?.orders ?? []);
    const withRider = all.filter((o) => o.rider);
    const active = withRider.filter((o) => ACTIVE.has(o.status));
    const recent = withRider.filter((o) => RECENT.has(o.status)).slice(0, 10);
    return [...active, ...recent];
  }, [orders.data]);

  if (!isAuthenticated) {
    return (
      <Screen>
        <View style={{ height: 56, alignItems: 'center', justifyContent: 'center' }}>
          <T variant="heading">Chat</T>
        </View>
        <EmptyState
          icon="message-circle"
          title="Sign in to chat"
          body="Message your rider while an order is on its way."
          actionLabel="Sign In"
          onAction={promptLogin}
        />
      </Screen>
    );
  }

  return (
    <Screen>
      <View style={{ height: 56, alignItems: 'center', justifyContent: 'center' }}>
        <T variant="heading">Chat</T>
      </View>
      {orders.isLoading ? (
        <LoadingBlock />
      ) : orders.isError ? (
        <ErrorState onRetry={() => orders.refetch()} />
      ) : rows.length === 0 ? (
        <EmptyState
          icon="message-circle"
          title="No conversations yet"
          body="When a rider picks up your order, you can message them here."
        />
      ) : (
        <FlatList
          data={rows}
          keyExtractor={(o) => o.id}
          contentContainerStyle={{ padding: space['2xl'], gap: space.md }}
          renderItem={({ item: o }) => {
            const rider = o.rider?.user ?? o.rider;
            const name = `${rider?.firstName ?? 'Rider'}`.trim();
            const live = ACTIVE.has(o.status);
            return (
              <Card style={{ flexDirection: 'row', alignItems: 'center', gap: space.md, padding: space.md }}>
                {rider?.avatar ? (
                  <Image source={{ uri: rider.avatar }} style={{ width: 52, height: 52, borderRadius: 26 }} />
                ) : (
                  <View
                    style={{
                      width: 52,
                      height: 52,
                      borderRadius: 26,
                      backgroundColor: color.brand[50],
                      alignItems: 'center',
                      justifyContent: 'center',
                    }}
                  >
                    <Feather name="user" size={22} color={color.brand[600]} />
                  </View>
                )}
                <View style={{ flex: 1, gap: 2 }}>
                  <T variant="body" weight="semibold">
                    {name}
                  </T>
                  <T variant="caption" tone="muted" numberOfLines={1}>
                    {o.vendor?.name} · #{o.orderNumber}
                  </T>
                </View>
                <View style={{ alignItems: 'flex-end', gap: 6 }}>
                  {live ? (
                    <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: color.success }} />
                  ) : null}
                  <T
                    variant="caption"
                    tone="brand"
                    weight="semibold"
                    onPress={() => navigation.navigate('Conversation', { orderId: o.id, title: name })}
                  >
                    Open
                  </T>
                </View>
              </Card>
            );
          }}
        />
      )}
    </Screen>
  );
}
