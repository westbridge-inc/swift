import { View, FlatList } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useQuery } from '@tanstack/react-query';
import { authApi } from '../../services/api';
import { useAuthStore } from '../../stores/authStore';
import { Feather } from '@expo/vector-icons';
import { color } from '@swift/ui';
import { Text, Heading, Card, PressableScale, StepProgress, Skeleton, EmptyState } from '../../components/ui';
import { SwiftMark } from '../../components/SwiftLogo';

export function CountryPickerScreen() {
  const setCountry = useAuthStore((s) => s.setCountry);
  const { data, isLoading } = useQuery({
    queryKey: ['countries'],
    queryFn: async () => (await authApi.countries()).data?.data,
  });
  const countries: any[] = data ?? [];

  return (
    <SafeAreaView style={{ flex: 1 }} edges={['top', 'bottom']} className="bg-surface-base">
      <View className="flex-1 px-lg pt-2xl">
        <View className="flex-row items-center">
          <SwiftMark size={42} />
          <Heading size="3xl" className="ml-sm text-text-primary">
            Swift
          </Heading>
        </View>
        <Heading size="xl" className="mt-xl">
          Where are you?
        </Heading>
        <Text className="mt-xs text-text-secondary">Choose your country to get started.</Text>
        <View className="mt-lg">
          <StepProgress step={0} total={4} />
        </View>

        {isLoading ? (
          <View className="mt-lg">
            {[0, 1, 2, 3, 4].map((i) => (
              <Skeleton key={i} className="mb-sm h-16 w-full rounded-2xl" />
            ))}
          </View>
        ) : (
          <FlatList
            className="mt-lg"
            data={countries}
            keyExtractor={(c) => c.code}
            showsVerticalScrollIndicator={false}
            renderItem={({ item }) => {
              const live = item.isActive !== false;
              return (
                <PressableScale
                  disabled={!live}
                  onPress={() =>
                    setCountry({
                      code: item.code,
                      dialCode: item.dialCode,
                      currencyCode: item.currencyCode,
                      currencySymbol: item.currencySymbol,
                    })
                  }
                >
                  <Card className={live ? 'mb-sm flex-row items-center justify-between' : 'mb-sm flex-row items-center justify-between opacity-50'}>
                    <View className="flex-1 pr-md">
                      <Text className="text-base font-semibold">{item.name}</Text>
                      <Text className="mt-xs text-xs text-text-muted">
                        {item.dialCode} · {item.currencySymbol} {item.currencyCode}
                      </Text>
                    </View>
                    {live ? (
                      <Feather name="chevron-right" size={18} color={color.text.muted} />
                    ) : (
                      <View className="rounded-full bg-surface-subtle px-2 py-1">
                        <Text className="text-xs font-semibold text-text-secondary">Coming soon</Text>
                      </View>
                    )}
                  </Card>
                </PressableScale>
              );
            }}
            ListEmptyComponent={
              <EmptyState icon="map-search-outline" title="No countries yet" body="We’re expanding across the Caribbean — check back soon." />
            }
          />
        )}
        <Text className="mt-md text-center text-xs text-text-muted">More countries coming soon.</Text>
      </View>
    </SafeAreaView>
  );
}
