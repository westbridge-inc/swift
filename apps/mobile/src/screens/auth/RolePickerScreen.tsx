import { View, ScrollView } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Feather, MaterialCommunityIcons } from '@expo/vector-icons';
import { color } from '@swift/ui';
import { Text, Heading, PressableScale, elevation } from '../../components/ui';
import { SwiftMark } from '../../components/SwiftLogo';
import { useAuthStore } from '../../stores/authStore';

type Intent = 'customer' | 'mover' | 'vendor';

const ROLES: {
  intent: Intent;
  icon: keyof typeof MaterialCommunityIcons.glyphMap;
  title: string;
  sub: string;
  tag?: string;
}[] = [
  { intent: 'customer', icon: 'shopping-outline', title: 'Order on Swift', sub: 'Food, groceries, rides, courier & services' },
  { intent: 'mover', icon: 'car', title: 'Drive & deliver', sub: 'Taxi rides, food, parcels — keep every fare', tag: 'Verify in ~24h' },
  { intent: 'vendor', icon: 'storefront-outline', title: 'Sell on Swift', sub: 'Restaurant, grocery, shop or services' },
];

// The single app's entry screen. Picking an option only sets `intent`;
// RootNavigator reacts — customers browse straight away as a guest, earners are
// routed into the sign-in + onboarding flow. No navigation here (no dead ends).
export function RolePickerScreen() {
  const setIntent = useAuthStore((s) => s.setIntent);
  return (
    <SafeAreaView style={{ flex: 1 }} edges={['top', 'bottom']} className="bg-surface-subtle">
      <ScrollView
        contentContainerStyle={{ flexGrow: 1, paddingHorizontal: 20, paddingTop: 28, paddingBottom: 24 }}
        showsVerticalScrollIndicator={false}
      >
        <SwiftMark size={40} />
        <Heading size="2xl" className="mt-lg">
          How will you use Swift?
        </Heading>
        <Text className="mt-xs text-[15px] leading-5 text-text-secondary">
          You can add another role later from your account.
        </Text>

        <View className="mt-xl" style={{ gap: 12 }}>
          {ROLES.map((r) => (
            <PressableScale key={r.intent} onPress={() => setIntent(r.intent)}>
              <View className="flex-row items-center rounded-3xl bg-surface-base p-lg" style={elevation.card}>
                <View className="h-14 w-14 items-center justify-center rounded-2xl" style={{ backgroundColor: color.brand[500] }}>
                  <MaterialCommunityIcons name={r.icon} size={28} color="#fff" />
                </View>
                <View className="ml-md flex-1">
                  <View className="flex-row items-center" style={{ gap: 8 }}>
                    <Text className="text-base font-bold text-text-primary">{r.title}</Text>
                    {r.tag ? (
                      <View className="rounded-full bg-brand-50 px-2 py-0.5">
                        <Text className="text-[10px] font-bold text-brand-700">{r.tag}</Text>
                      </View>
                    ) : null}
                  </View>
                  <Text className="mt-0.5 text-sm text-text-secondary">{r.sub}</Text>
                </View>
                <Feather name="chevron-right" size={22} color={color.text.muted} />
              </View>
            </PressableScale>
          ))}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}
