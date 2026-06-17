import { View, Pressable } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Text, Heading, Card } from '../../components/ui';

const ROLES = [
  { key: 'CUSTOMER', emoji: '🛍️', title: 'Order on Swift', sub: 'Food, groceries, rides, courier & services' },
  { key: 'MOVER', emoji: '🛵', title: 'Drive & deliver', sub: 'Earn delivering parcels & driving riders' },
  { key: 'VENDOR', emoji: '🏪', title: 'Sell on Swift', sub: 'List your restaurant, shop or services' },
];

export function RolePickerScreen({ route, navigation }: any) {
  const phone = route?.params?.phone;
  return (
    <SafeAreaView style={{ flex: 1 }} edges={['top', 'bottom']} className="bg-surface-base">
      <View className="flex-1 px-lg pt-2xl">
        <Heading size="xl">How will you use Swift?</Heading>
        <Text className="mt-xs text-text-secondary">You can add another role later from your account.</Text>
        <View className="mt-xl">
          {ROLES.map((r) => (
            <Pressable key={r.key} onPress={() => navigation?.navigate?.('Register', { phone, role: r.key })}>
              <Card className="mb-md flex-row items-center">
                <Text className="text-3xl">{r.emoji}</Text>
                <View className="ml-md flex-1">
                  <Text className="text-base font-semibold">{r.title}</Text>
                  <Text className="mt-xs text-sm text-text-secondary">{r.sub}</Text>
                </View>
                <Text className="text-xl text-brand-500">›</Text>
              </Card>
            </Pressable>
          ))}
        </View>
      </View>
    </SafeAreaView>
  );
}
