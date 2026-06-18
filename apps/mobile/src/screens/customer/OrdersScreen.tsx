import { memo } from 'react';
import { View, Pressable, RefreshControl } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Feather, MaterialCommunityIcons } from '@expo/vector-icons';
import { color } from '@swift/ui';
import { Text, Heading, Card, Badge, Skeleton, Button, List } from '../../components/ui';
import { useOrders, useReorder } from '../../hooks';
import { money } from '../../lib/money';

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

const statusTone = (s: string): 'brand' | 'success' => (s === 'DELIVERED' || s === 'COMPLETED' ? 'success' : 'brand');
const prettyStatus = (s: string) => (s || '').toLowerCase().replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
function fmtDate(d?: string) {
  if (!d) return '';
  try {
    return new Date(d).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  } catch {
    return '';
  }
}

const OrderRow = memo(function OrderRow({ order, onTrack, onReorder, reordering }: any) {
  const title = order.vendor?.name ?? TYPE_LABEL[order.orderType] ?? 'Order';
  const reorderable = !!order.vendor && (order.status === 'DELIVERED' || order.status === 'COMPLETED');
  return (
    <Pressable onPress={onTrack}>
      <Card className="mb-md">
        <View className="flex-row items-center">
          <View className="h-11 w-11 items-center justify-center rounded-full bg-brand-50">
            <MaterialCommunityIcons name={iconFor(order.orderType)} size={20} color={color.brand[500]} />
          </View>
          <View className="flex-1 px-md">
            <Text className="text-base font-semibold" numberOfLines={1}>{title}</Text>
            <Text className="mt-xs text-sm text-text-secondary">
              {order.itemCount ? `${order.itemCount} item${order.itemCount > 1 ? 's' : ''} · ` : ''}
              {money(order.totalAmount)}
              {fmtDate(order.placedAt) ? ` · ${fmtDate(order.placedAt)}` : ''}
            </Text>
          </View>
          <Badge label={prettyStatus(order.status)} tone={statusTone(order.status)} />
        </View>
        {reorderable ? (
          <Pressable
            onPress={onReorder}
            disabled={reordering}
            className="mt-sm flex-row items-center self-start rounded-full border border-brand-500 px-lg py-sm"
          >
            <Feather name="refresh-cw" size={13} color={color.brand[500]} />
            <Text className="ml-sm text-sm font-semibold text-brand-500">Reorder</Text>
          </Pressable>
        ) : null}
      </Card>
    </Pressable>
  );
});

export function OrdersScreen({ navigation }: any) {
  const { data, isLoading, isError, refetch, isRefetching } = useOrders<any[]>();
  const reorder = useReorder();
  const orders = data ?? [];

  if (isLoading) {
    return (
      <SafeAreaView style={{ flex: 1 }} edges={['top']} className="bg-surface-base">
        <View className="px-lg pt-md">
          <Heading size="2xl" className="mb-md">Orders</Heading>
          {[0, 1, 2, 3].map((i) => <Skeleton key={i} className="mb-md h-24 w-full rounded-2xl" />)}
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={{ flex: 1 }} edges={['top']} className="bg-surface-base">
      <View className="px-lg pb-sm pt-md">
        <Heading size="2xl">Orders</Heading>
      </View>
      {isError ? (
        <View className="flex-1 items-center justify-center px-2xl">
          <Feather name="alert-triangle" size={32} color={color.text.muted} />
          <Text className="mt-sm text-center text-text-secondary">Couldn&apos;t load your orders.</Text>
          <Button label="Retry" className="mt-md" onPress={() => refetch()} />
        </View>
      ) : (
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
            />
          )}
          ListEmptyComponent={
            <View className="items-center justify-center px-2xl pt-5xl">
              <MaterialCommunityIcons name="receipt-text-outline" size={40} color={color.text.muted} />
              <Heading size="lg" className="mt-md">No orders yet</Heading>
              <Text className="mt-xs text-center text-text-secondary">
                Your orders across food, taxi, courier and services show up here.
              </Text>
            </View>
          }
        />
      )}
    </SafeAreaView>
  );
}
