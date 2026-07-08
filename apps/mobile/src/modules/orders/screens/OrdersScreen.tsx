import { memo } from 'react';
import { View, RefreshControl } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Image } from 'expo-image';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { color } from '@swift/ui';
import { Text, Card, Badge, Skeleton, List, PressableScale, EmptyState } from '../../../components/ui';
import { useOrders, useReorder } from '../../../hooks';
import { useAuthStore } from '../../../stores/authStore';
import { money } from '../../../lib/money';
import { vendorImage } from '../../../lib/images';

const TYPE_LABEL: Record<string, string> = {
  TAXI: 'Taxi ride',
  COURIER: 'Package delivery',
  SERVICE: 'Service',
};
const TYPE_ICON: Record<string, keyof typeof MaterialCommunityIcons.glyphMap> = {
  TAXI: 'car',
  COURIER: 'package-variant',
  SERVICE: 'tools',
};
const iconFor = (t?: string) => TYPE_ICON[t ?? ''] ?? 'silverware-fork-knife';

const statusTone = (s: string): 'brand' | 'success' | 'error' =>
  s === 'DELIVERED' || s === 'COMPLETED' ? 'success' : s === 'CANCELLED' || s === 'REFUNDED' ? 'error' : 'brand';
const prettyStatus = (s: string) => (s || '').toLowerCase().replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
function fmtDate(d?: string) {
  if (!d) return '';
  try {
    return new Date(d).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  } catch {
    return '';
  }
}

/** Kit "Card Recent Order": landscape thumb r8 + info column, borderless card. */
const OrderRow = memo(function OrderRow({ order, onTrack, onReorder, onRate, reordering }: any) {
  const title = order.vendor?.name ?? TYPE_LABEL[order.orderType] ?? 'Order';
  const completed = order.status === 'DELIVERED' || order.status === 'COMPLETED';
  const reorderable = !!order.vendor && completed;
  // Same identity Home/Search show for this vendor (cover → logo → type-aware photo).
  const logo = order.vendor ? vendorImage(order.vendor) : null;
  const meta = [
    order.itemCount ? `${order.itemCount} item${order.itemCount > 1 ? 's' : ''}` : '',
    fmtDate(order.placedAt),
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <PressableScale onPress={onTrack}>
      <Card className="mb-md">
        <View className="flex-row items-center">
          {logo ? (
            <Image source={{ uri: logo }} style={{ width: 96, height: 60, borderRadius: 8 }} contentFit="cover" transition={150} />
          ) : (
            <View
              className="items-center justify-center"
              style={{ width: 96, height: 60, borderRadius: 8, backgroundColor: color.brand[50] }}
            >
              <MaterialCommunityIcons name={iconFor(order.orderType)} size={24} color={color.brand[500]} />
            </View>
          )}
          <View className="ml-md flex-1">
            <View className="flex-row items-center">
              <Text className="flex-1 text-base font-semibold text-text-primary" numberOfLines={1}>{title}</Text>
              <Badge label={prettyStatus(order.status)} tone={statusTone(order.status)} />
            </View>
            {meta ? <Text className="mt-xs text-xs text-text-secondary">{meta}</Text> : null}
            <Text className="mt-xs text-sm font-bold" style={{ color: color.brand[500] }}>{money(order.totalAmount)}</Text>
          </View>
        </View>
        {completed ? (
          <View className="mt-md flex-row" style={{ gap: 8 }}>
            <PressableScale
              onPress={onRate}
              className="flex-1 flex-row items-center justify-center rounded-full bg-surface-subtle"
              style={{ height: 40 }}
            >
              <MaterialCommunityIcons name="star-outline" size={15} color={color.text.primary} />
              <Text className="ml-sm text-sm font-semibold text-text-primary">Rate</Text>
            </PressableScale>
            {reorderable ? (
              <PressableScale
                onPress={onReorder}
                disabled={reordering}
                className="flex-1 flex-row items-center justify-center rounded-full"
                style={{ height: 40, backgroundColor: color.brand[500] }}
              >
                <MaterialCommunityIcons name="refresh" size={15} color={color.white} />
                <Text className="ml-sm text-sm font-semibold text-white">Re-Order</Text>
              </PressableScale>
            ) : null}
          </View>
        ) : null}
      </Card>
    </PressableScale>
  );
});

function Header() {
  return (
    <View className="px-lg pb-md pt-md">
      <Text className="font-display font-extrabold text-text-primary" style={{ fontSize: 26, lineHeight: 32 }}>
        Orders
      </Text>
      <Text className="mt-xs text-sm text-text-secondary">Food, groceries, rides and more</Text>
    </View>
  );
}

export function OrdersScreen({ navigation }: any) {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const promptLogin = useAuthStore((s) => s.promptLogin);
  if (!isAuthenticated) {
    return (
      <SafeAreaView style={{ flex: 1, backgroundColor: color.surface.subtle }} edges={['top']}>
        <Header />
        <View className="flex-1 items-center justify-center">
          <EmptyState
            icon="receipt-text-outline"
            title="Sign in to see your orders"
            body="Your food, taxi, courier and service orders live here once you have an account."
            actionLabel="Sign in"
            onAction={promptLogin}
          />
        </View>
      </SafeAreaView>
    );
  }
  return <SignedInOrders navigation={navigation} />;
}

function SignedInOrders({ navigation }: any) {
  const { data, isLoading, isError, refetch, isRefetching } = useOrders<any[]>();
  const reorder = useReorder();
  const orders = data ?? [];

  if (isLoading) {
    return (
      <SafeAreaView style={{ flex: 1, backgroundColor: color.surface.subtle }} edges={['top']}>
        <Header />
        <View className="px-lg">
          {[0, 1, 2, 3].map((i) => <Skeleton key={i} className="mb-md h-24 w-full rounded-2xl" />)}
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: color.surface.subtle }} edges={['top']}>
      <Header />
      {isError ? (
        <View className="flex-1 items-center justify-center">
          <EmptyState
            icon="alert-circle-outline"
            title="Couldn’t load your orders"
            body="Pull to refresh or try again."
            actionLabel="Retry"
            onAction={() => refetch()}
          />
        </View>
      ) : (
        <View style={{ flex: 1 }}>
        <List
          data={orders}
          keyExtractor={(o: any) => String(o.id)}
          contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 32 }}
          refreshControl={<RefreshControl refreshing={isRefetching} onRefresh={() => refetch()} tintColor={color.brand[500]} />}
          renderItem={({ item }: { item: any }) => (
            <OrderRow
              order={item}
              reordering={reorder.isPending}
              onTrack={() => navigation?.navigate?.('OrderTracking', { id: item.id })}
              onReorder={() => reorder.mutate(item.id, { onSuccess: () => navigation?.navigate?.('Cart') })}
              onRate={() => navigation?.navigate?.('RateOrder', { orderId: item.id, vendorName: item.vendor?.name, hasRider: item.fulfillment === 'DELIVERY' || !!item.riderId })}
            />
          )}
          ListEmptyComponent={
            <View className="pt-2xl">
              <EmptyState
                icon="receipt-text-outline"
                title="No orders yet"
                body="Your orders across food, taxi, courier and services show up here."
              />
            </View>
          }
        />
        </View>
      )}
    </SafeAreaView>
  );
}
