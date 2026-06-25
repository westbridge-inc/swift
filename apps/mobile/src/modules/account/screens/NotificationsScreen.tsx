import { View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { color } from '@swift/ui';
import { Text, Card, List, PressableScale, EmptyState, Skeleton } from '../../../components/ui';
import { useNotifications } from '../../../hooks';

function timeAgo(iso: string) {
  const ms = Date.now() - new Date(iso).getTime();
  const h = Math.floor(ms / 3.6e6);
  if (h < 1) return 'Just now';
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export function NotificationsScreen({ navigation }: any) {
  const { data, isLoading } = useNotifications<any[]>();
  const list = data ?? [];

  return (
    <SafeAreaView style={{ flex: 1 }} edges={['top']} className="bg-surface-base">
      <View className="flex-row items-center px-lg py-sm">
        <PressableScale onPress={() => navigation?.goBack?.()} hitSlop={10}>
          <Feather name="chevron-left" size={24} color={color.text.primary} />
        </PressableScale>
        <Text className="ml-md text-base font-bold">Notifications</Text>
      </View>

      <View style={{ flex: 1 }}>
        <List
          data={list}
          keyExtractor={(n: any) => String(n.id)}
          renderItem={({ item }: { item: any }) => (
            <View className="px-lg">
              <Card className={item.isRead ? 'mb-sm' : 'mb-sm border-brand-500'}>
                <View className="flex-row items-center">
                  <Text className="flex-1 pr-sm text-base font-semibold" numberOfLines={1}>{item.title}</Text>
                  <Text className="text-xs text-text-muted">{timeAgo(item.createdAt)}</Text>
                </View>
                <Text className="mt-xs text-sm text-text-secondary">{item.body}</Text>
              </Card>
            </View>
          )}
          contentContainerStyle={{ paddingBottom: 32 }}
          ListEmptyComponent={
            isLoading ? (
              <View className="px-lg pt-sm">
                {[0, 1, 2, 3].map((i) => (
                  <Skeleton key={i} className="mb-sm h-20 w-full rounded-2xl" />
                ))}
              </View>
            ) : (
              <EmptyState icon="bell-outline" title="No notifications yet" body="Order updates and offers will show up here." />
            )
          }
        />
      </View>
    </SafeAreaView>
  );
}
