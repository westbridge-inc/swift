import { View, FlatList, Pressable } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useQuery } from '@tanstack/react-query';
import { authApi } from '../../services/api';
import { useAuthStore } from '../../stores/authStore';
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
          swift
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
            renderItem={({ item }) => (
              <Pressable onPress={() => setCountry(item.code)}>
                <Card className="mb-sm flex-row items-center justify-between">
                  <Text className="text-base font-semibold">{item.name}</Text>
                  <Text className="text-text-muted">
                    {item.currencySymbol} {item.currencyCode}
                  </Text>
                </Card>
              </Pressable>
            )}
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
