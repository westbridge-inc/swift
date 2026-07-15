import { View, FlatList } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useQuery } from '@tanstack/react-query';
import { authApi } from '../../services/api';
import { useAuthStore } from '../../stores/authStore';
import { Feather } from '@expo/vector-icons';
import { color } from '@swift/ui';
import { Text, Heading, PressableScale, StepProgress, Skeleton, EmptyState, elevation } from '../../components/ui';
import { SwiftMark } from '../../components/SwiftLogo';
import { flagEmoji } from '../../lib/flags';

// Step 0 of onboarding — pick your country. The list is the live CountryConfig
// (/auth/countries): Guyana is active; the rest of the Caribbean shows "Soon".
// Haiti / Cuba / Puerto Rico are deliberately not in the backend's market list.
export function CountryPickerScreen({ navigation }: any) {
  const setCountry = useAuthStore((s) => s.setCountry);
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['countries'],
    queryFn: async () => (await authApi.countries()).data?.data,
  });
  const countries: any[] = data ?? [];

  const choose = (item: any) => {
    setCountry({
      code: item.code,
      dialCode: item.dialCode,
      currencyCode: item.currencyCode,
      currencySymbol: item.currencySymbol,
    });
    // This screen appears two ways. As the root "Country" gate (first run) it's
    // the only screen in its navigator — nothing to pop, and RootNavigator
    // advances by conditional render (earner → AuthStack, customer → browsing).
    // Pushed on top of PhoneEntry via "Change country", it must pop back. The
    // old unconditional navigate('PhoneEntry') threw "not handled by any
    // navigator" for customers (whose stack has no PhoneEntry); canGoBack tells
    // the two contexts apart.
    if (navigation?.canGoBack?.()) navigation.goBack();
  };

  return (
    <SafeAreaView style={{ flex: 1 }} edges={['top', 'bottom']} className="bg-surface-subtle">
      <View className="flex-1 px-lg pt-2xl">
        <View className="flex-row items-center">
          <SwiftMark size={40} />
          <Heading size="3xl" className="ml-sm text-text-primary">Swift</Heading>
        </View>
        <Heading size="xl" className="mt-xl">Where are you?</Heading>
        <Text className="mt-xs text-text-secondary">
          Choose your country to get started — Swift is live across the Caribbean.
        </Text>
        <View className="mt-lg">
          <StepProgress step={0} total={4} />
        </View>

        {isLoading ? (
          <View className="mt-lg">
            {[0, 1, 2, 3, 4].map((i) => <Skeleton key={i} className="mb-sm h-[68px] w-full rounded-3xl" />)}
          </View>
        ) : isError || countries.length === 0 ? (
          // The very first screen of the app must never dead-end silently —
          // an unreachable API previously rendered an empty list with no way out.
          <View className="mt-xl">
            <EmptyState
              icon="wifi-off"
              title="Can't reach Swift"
              body="We couldn't load the country list. Check your connection and try again."
              actionLabel="Try again"
              onAction={() => refetch()}
            />
          </View>
        ) : (
          <FlatList
            className="mt-lg"
            data={countries}
            keyExtractor={(c) => c.code}
            showsVerticalScrollIndicator={false}
            contentContainerStyle={{ paddingBottom: 24 }}
            renderItem={({ item }) => {
              const live = item.isActive !== false;
              return (
                <PressableScale disabled={!live} onPress={() => choose(item)}>
                  <View
                    className={
                      live
                        ? 'mb-sm flex-row items-center rounded-3xl bg-surface-base p-md'
                        : 'mb-sm flex-row items-center rounded-3xl bg-surface-base p-md opacity-60'
                    }
                    style={elevation.card}
                  >
                    <View className="h-12 w-12 items-center justify-center rounded-2xl bg-surface-subtle">
                      <Text style={{ fontSize: 26 }}>{flagEmoji(item.code)}</Text>
                    </View>
                    <View className="ml-md flex-1">
                      <Text className="text-base font-bold text-text-primary" numberOfLines={1}>{item.name}</Text>
                      <Text className="mt-0.5 text-xs text-text-muted">
                        {item.dialCode} · {item.currencySymbol} {item.currencyCode}
                      </Text>
                    </View>
                    {live ? (
                      <View className="h-9 w-9 items-center justify-center rounded-full" style={{ backgroundColor: color.brand[50] }}>
                        <Feather name="chevron-right" size={18} color={color.brand[500]} />
                      </View>
                    ) : (
                      <View className="rounded-full bg-surface-subtle px-2.5 py-1">
                        <Text className="text-xs font-bold text-text-secondary">Soon</Text>
                      </View>
                    )}
                  </View>
                </PressableScale>
              );
            }}
            ListEmptyComponent={
              <EmptyState icon="map-search-outline" title="No countries yet" body="We’re expanding across the Caribbean — check back soon." />
            }
          />
        )}
      </View>
    </SafeAreaView>
  );
}
