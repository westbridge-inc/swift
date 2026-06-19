import { View, Pressable } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Feather, MaterialCommunityIcons } from '@expo/vector-icons';
import { color } from '@swift/ui';
import { Text, Card, List } from '../../components/ui';
import { useNotifications } from '../../hooks';

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
        <Pressable onPress={() => navigation?.goBack?.()} hitSlop={10}>
          <Feather name="chevron-left" size={24} color={color.text.primary} />
        </Pressable>
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
            isLoading ? null : (
              <View className="items-center px-2xl pt-3xl">
                <MaterialCommunityIcons name="bell-outline" size={48} color={color.text.muted} />
                <Text className="mt-md text-center text-text-secondary">No notifications yet.</Text>
              </View>
            )
          }
        />
      </View>
    </SafeAreaView>
  );
}
