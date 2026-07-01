import { View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Feather, MaterialCommunityIcons } from '@expo/vector-icons';
import { color } from '@swift/ui';
import { Text, Heading, Card, PressableScale } from '../../components/ui';
import { SwiftMark } from '../../components/SwiftLogo';
import { useAuthStore } from '../../stores/authStore';

type Intent = 'customer' | 'mover' | 'vendor';

const ROLES: { intent: Intent; icon: keyof typeof MaterialCommunityIcons.glyphMap; title: string; sub: string }[] = [
  { intent: 'customer', icon: 'shopping-outline', title: 'Order on Swift', sub: 'Food, groceries, rides, courier & services' },
  { intent: 'mover', icon: 'moped', title: 'Drive & deliver', sub: 'Earn delivering parcels & driving riders' },
  { intent: 'vendor', icon: 'storefront-outline', title: 'Sell on Swift', sub: 'List your restaurant, shop or services' },
];

// The single app's entry screen. Picking an option only sets `intent`;
// RootNavigator reacts — customers go straight to browsing as a guest, earners
// are routed into the sign-in + onboarding flow. No navigation here, so there's
// no route to "not handle".
export function RolePickerScreen() {
  const setIntent = useAuthStore((s) => s.setIntent);
  return (
    <SafeAreaView style={{ flex: 1 }} edges={['top', 'bottom']} className="bg-surface-base">
      <View className="flex-1 px-lg pt-2xl">
        <SwiftMark size={44} />
        <Heading size="xl" className="mt-md">How will you use Swift?</Heading>
        <Text className="mt-xs text-text-secondary">You can switch anytime from your account.</Text>
        <View className="mt-2xl">
          {ROLES.map((r) => (
            <PressableScale key={r.intent} onPress={() => setIntent(r.intent)}>
              <Card className="mb-md flex-row items-center">
                <View className="h-12 w-12 items-center justify-center rounded-2xl bg-brand-50">
                  <MaterialCommunityIcons name={r.icon} size={24} color={color.brand[500]} />
                </View>
                <View className="ml-md flex-1">
                  <Text className="text-base font-semibold">{r.title}</Text>
                  <Text className="mt-xs text-sm text-text-secondary">{r.sub}</Text>
                </View>
                <Feather name="chevron-right" size={20} color={color.text.muted} />
              </Card>
            </PressableScale>
          ))}
        </View>
      </View>
    </SafeAreaView>
  );
}
