import { View, FlatList, Pressable, RefreshControl } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { color } from '@swift/ui';
import { Text, Heading, Card, Badge, Skeleton, Button } from '../../components/ui';
import { useOrders, useReorder } from '../../hooks';
import { money } from '../../lib/money';

const TYPE_LABEL: Record<string, string> = {
  TAXI: 'Taxi ride',
  COURIER: 'Package delivery',
  SERVICE: 'Service',
};

function statusTone(s: string): 'brand' | 'success' {
  return s === 'DELIVERED' || s === 'COMPLETED' ? 'success' : 'brand';
}

function prettyStatus(s: string) {
  return (s || '')
    .toLowerCase()
    .replace(/_/g, ' ')
    .replace(/^\w/, (c) => c.toUpperCase());
}

function fmtDate(d?: string) {
  if (!d) return '';
  try {
    return new Date(d).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  } catch {
    return '';
  }
}

export function OrdersScreen({ navigation }: any) {
  const { data, isLoading, isError, refetch, isRefetching } = useOrders<any[]>();
  const reorder = useReorder();
  const orders = data ?? [];

  if (isLoading) {
    return (
      <SafeAreaView style={{ flex: 1 }} edges={['top']} className="bg-surface-base">
        <View className="px-lg pt-md">
          <Heading size="2xl" className="mb-md">
            Orders
          </Heading>
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="mb-md h-24 w-full" />
          ))}
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
          <Text className="text-3xl">⚠️</Text>
          <Text className="mt-sm text-center text-text-secondary">Couldn&apos;t load your orders.</Text>
          <Button label="Retry" className="mt-md" onPress={() => refetch()} />
        </View>
      ) : (
        <FlatList
          data={orders}
          keyExtractor={(o) => o.id}
          contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 32 }}
          showsVerticalScrollIndicator={false}
          refreshControl={
            <RefreshControl refreshing={isRefetching} onRefresh={() => refetch()} tintColor={color.brand[500]} />
          }
          renderItem={({ item }) => {
            const title = item.vendor?.name ?? TYPE_LABEL[item.orderType] ?? 'Order';
            const reorderable = !!item.vendor && (item.status === 'DELIVERED' || item.status === 'COMPLETED');
            return (
              <Pressable onPress={() => navigation?.navigate?.('OrderTracking', { id: item.id })}>
                <Card className="mb-md">
                  <View className="flex-row items-start justify-between">
                    <View className="flex-1 pr-md">
                      <Text className="text-base font-semibold" numberOfLines={1}>
                        {title}
                      </Text>
                      <Text className="mt-xs text-sm text-text-secondary">
                        {item.itemCount ? `${item.itemCount} item${item.itemCount > 1 ? 's' : ''} · ` : ''}
                        {money(item.totalAmount)}
                        {fmtDate(item.placedAt) ? ` · ${fmtDate(item.placedAt)}` : ''}
                      </Text>
                    </View>
                    <Badge label={prettyStatus(item.status)} tone={statusTone(item.status)} />
                  </View>
                  {reorderable ? (
                    <Pressable
                      onPress={() => reorder.mutate(item.id, { onSuccess: () => navigation?.navigate?.('Cart') })}
                      disabled={reorder.isPending}
                      className="mt-sm self-start rounded-full border border-brand-500 px-lg py-sm"
                    >
                      <Text className="text-sm font-semibold text-brand-500">Reorder</Text>
                    </Pressable>
                  ) : null}
                </Card>
              </Pressable>
            );
          }}
          ListEmptyComponent={
            <View className="items-center justify-center px-2xl pt-5xl">
              <Text className="text-5xl">🧾</Text>
              <Heading size="lg" className="mt-md">
                No orders yet
              </Heading>
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
