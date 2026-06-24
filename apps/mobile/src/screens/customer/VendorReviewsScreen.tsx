import { View, ScrollView } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Feather, MaterialCommunityIcons } from '@expo/vector-icons';
import { color } from '@swift/ui';
import { Text, PressableScale, Skeleton, EmptyState } from '../../components/ui';
import { useVendorReviews } from '../../hooks';

function Stars({ value, size = 14 }: { value: number; size?: number }) {
  const rounded = Math.round(value);
  return (
    <View className="flex-row">
      {[1, 2, 3, 4, 5].map((i) => (
        <MaterialCommunityIcons key={i} name={i <= rounded ? 'star' : 'star-outline'} size={size} color={color.brand[500]} />
      ))}
    </View>
  );
}

function fmtDate(d?: string) {
  if (!d) return '';
  try {
    return new Date(d).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  } catch {
    return '';
  }
}

export function VendorReviewsScreen({ navigation, route }: any) {
  const id: string = route?.params?.id ?? '';
  const name: string = route?.params?.vendorName ?? 'Reviews';
  const avg = Number(route?.params?.averageRating ?? 0);

  const { data, isLoading } = useVendorReviews<any>(id);
  const reviews: any[] = data?.reviews ?? [];
  const total: number = data?.total ?? 0;
  const dist: Record<string, number> = data?.distribution ?? {};
  const maxDist = Math.max(1, ...[5, 4, 3, 2, 1].map((s) => Number(dist[s] ?? 0)));

  return (
    <SafeAreaView style={{ flex: 1 }} edges={['top']} className="bg-surface-base">
      <View className="flex-row items-center px-lg py-sm">
        <PressableScale onPress={() => navigation?.goBack?.()} hitSlop={10}>
          <Feather name="chevron-left" size={24} color={color.text.primary} />
        </PressableScale>
        <Text className="ml-md flex-1 text-base font-bold text-text-primary" numberOfLines={1}>{name}</Text>
      </View>

      <ScrollView contentContainerStyle={{ paddingBottom: 32 }} showsVerticalScrollIndicator={false}>
        <View className="items-center pb-md pt-sm">
          <Text className="font-display text-3xl font-bold text-text-primary">{avg > 0 ? avg.toFixed(1) : 'New'}</Text>
          <View className="mt-xs"><Stars value={avg} size={18} /></View>
          <Text className="mt-xs text-sm text-text-muted">{total} {total === 1 ? 'review' : 'reviews'}</Text>
        </View>

        {total > 0 ? (
          <View className="mx-lg mb-md">
            {[5, 4, 3, 2, 1].map((s) => {
              const n = Number(dist[s] ?? 0);
              return (
                <View key={s} className="mb-1 flex-row items-center">
                  <Text className="w-3 text-xs text-text-secondary">{s}</Text>
                  <MaterialCommunityIcons name="star" size={12} color={color.brand[500]} />
                  <View className="mx-sm h-2 flex-1 overflow-hidden rounded-full bg-surface-subtle">
                    <View style={{ width: `${(n / maxDist) * 100}%`, height: '100%', backgroundColor: color.brand[500] }} />
                  </View>
                  <Text className="w-7 text-right text-xs text-text-muted">{n}</Text>
                </View>
              );
            })}
          </View>
        ) : null}

        <View className="h-2 bg-surface-subtle" />

        {isLoading ? (
          <View className="px-lg pt-md">
            {[0, 1, 2].map((i) => <Skeleton key={i} className="mb-md h-20 w-full rounded-2xl" />)}
          </View>
        ) : reviews.length === 0 ? (
          <View className="pt-2xl">
            <EmptyState icon="star-outline" title="No reviews yet" body="Be the first to rate this place after your order." />
          </View>
        ) : (
          reviews.map((r) => {
            const first = r.rater?.firstName ?? 'Guest';
            const initial = (first[0] || '?').toUpperCase();
            return (
              <View key={r.id} className="border-b border-border-subtle px-lg py-md">
                <View className="flex-row items-center">
                  <View className="h-9 w-9 items-center justify-center rounded-full bg-surface-subtle">
                    <Text className="text-sm font-bold text-text-secondary">{initial}</Text>
                  </View>
                  <View className="ml-md flex-1">
                    <Text className="text-sm font-semibold text-text-primary">{first}</Text>
                    <Text className="text-xs text-text-muted">{fmtDate(r.createdAt)}</Text>
                  </View>
                  <Stars value={Number(r.score ?? 0)} size={13} />
                </View>
                {r.comment ? <Text className="mt-sm text-sm text-text-secondary">{r.comment}</Text> : null}
              </View>
            );
          })
        )}
      </ScrollView>
    </SafeAreaView>
  );
}
