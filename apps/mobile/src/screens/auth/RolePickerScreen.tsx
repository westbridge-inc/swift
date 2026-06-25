import { View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Feather, MaterialCommunityIcons } from '@expo/vector-icons';
import { color } from '@swift/ui';
import { Text, Heading, Card, PressableScale, StepProgress } from '../../components/ui';
import { SwiftMark } from '../../components/SwiftLogo';
import { getAppVariant } from '../../lib/appVariant';

const ROLES: { key: string; icon: keyof typeof MaterialCommunityIcons.glyphMap; title: string; sub: string }[] = [
  { key: 'CUSTOMER', icon: 'shopping-outline', title: 'Order on Swift', sub: 'Food, groceries, rides, courier & services' },
  { key: 'MOVER', icon: 'moped', title: 'Drive & deliver', sub: 'Earn delivering parcels & driving riders' },
  { key: 'VENDOR', icon: 'storefront-outline', title: 'Sell on Swift', sub: 'List your restaurant, shop or services' },
];

export function RolePickerScreen({ route, navigation }: any) {
  const phone = route?.params?.phone;
  // The partner app is for EARNERS only — never offer "Order on Swift" (that's the
  // consumer app; customers order in the red app).
  const isPartner = getAppVariant() === 'partner';
  const roles = isPartner ? ROLES.filter((r) => r.key !== 'CUSTOMER') : ROLES;
  return (
    <SafeAreaView style={{ flex: 1 }} edges={['top', 'bottom']} className="bg-surface-base">
      <View className="flex-1 px-lg pt-2xl">
        <SwiftMark size={44} />
        <Heading size="xl" className="mt-md">{isPartner ? 'How do you want to earn?' : 'How will you use Swift?'}</Heading>
        <Text className="mt-xs text-text-secondary">
          {isPartner
            ? 'Riders, drivers and vendors keep 100% — Swift only charges a flat weekly fee.'
            : 'You can add another role later from your account.'}
        </Text>
        <View className="mt-lg">
          <StepProgress step={3} total={4} />
        </View>
        <View className="mt-xl">
          {roles.map((r) => (
            <PressableScale key={r.key} onPress={() => navigation?.navigate?.('Register', { phone, role: r.key })}>
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
