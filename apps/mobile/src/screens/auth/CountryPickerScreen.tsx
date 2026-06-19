import { View, FlatList, Pressable } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useQuery } from '@tanstack/react-query';
import { authApi } from '../../services/api';
import { useAuthStore } from '../../stores/authStore';
import { Feather } from '@expo/vector-icons';
import { color } from '@swift/ui';
import { Text, Heading, Card, Spinner } from '../../components/ui';

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
        <Heading size="3xl" className="text-brand-500">
          Swift
        </Heading>
        <Heading size="xl" className="mt-xl">
          Where are you?
        </Heading>
        <Text className="mt-xs text-text-secondary">Choose your country to get started.</Text>

        {isLoading ? (
          <View className="mt-2xl items-center">
            <Spinner size="large" />
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
                <Pressable
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
                </Pressable>
              );
            }}
            ListEmptyComponent={
              <Text className="mt-2xl text-center text-text-secondary">No countries available yet.</Text>
            }
          />
        )}
        <Text className="mt-md text-center text-xs text-text-muted">More countries coming soon.</Text>
      </View>
    </SafeAreaView>
  );
}
