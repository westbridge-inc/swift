import { View, RefreshControl } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { color } from '@swift/ui';
import { Text, List, Skeleton, EmptyState, PressableScale } from '../../components/ui';
import { VendorCard, type Vendor } from '../../components/customer/VendorCard';
import { useFavorites } from '../../hooks';

export function FavoritesScreen({ navigation }: any) {
  const { data, isLoading, refetch, isRefetching } = useFavorites<Vendor[]>();
  // Everything here is, by definition, a favourite — show the heart filled.
  const favorites = (data ?? []).map((v) => ({ ...v, isFavorite: true }));

  return (
    <SafeAreaView style={{ flex: 1 }} edges={['top']} className="bg-surface-base">
      <View className="flex-row items-center px-lg py-sm">
        <PressableScale onPress={() => navigation?.goBack?.()} hitSlop={10}>
          <Feather name="chevron-left" size={24} color={color.text.primary} />
        </PressableScale>
        <Text className="ml-md flex-1 text-base font-bold text-text-primary">Saved places</Text>
      </View>

      {isLoading ? (
        <View className="px-lg pt-sm">
          {[0, 1, 2].map((i) => <Skeleton key={i} className="mb-md h-48 w-full rounded-2xl" />)}
        </View>
      ) : (
        <List
          data={favorites}
          keyExtractor={(v: Vendor) => v.id}
          contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 32, paddingTop: 4 }}
          refreshControl={<RefreshControl refreshing={isRefetching} onRefresh={() => refetch()} tintColor={color.brand[500]} />}
          renderItem={({ item }: { item: Vendor }) => (
            <VendorCard vendor={item} onPress={() => navigation?.navigate?.('VendorDetail', { id: item.id })} />
          )}
          ListEmptyComponent={
            <View className="pt-2xl">
              <EmptyState
                icon="heart-outline"
                title="No saved places yet"
                body="Tap the heart on any place to save it here for next time."
              />
            </View>
          }
        />
      )}
    </SafeAreaView>
  );
}
