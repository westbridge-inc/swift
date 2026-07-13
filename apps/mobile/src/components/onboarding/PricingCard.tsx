import { View } from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { color } from '@swift/ui';
import { Text, Card } from '../ui';
import { usePartnerPricing } from '../../hooks/verification';
import { useAuthStore } from '../../stores/authStore';

/** The SaaS pitch, price on the door: partners see exactly what Swift costs
 *  BEFORE they commit — N days free, then the weekly fee, zero commission.
 *  Rates come from the country the account signed up in. */
export function PricingCard({ kind }: { kind: 'mover' | 'vendor' }) {
  const user = useAuthStore((s) => s.user) as { countryCode?: string } | null;
  const pricing = usePartnerPricing(user?.countryCode);
  const p = pricing.data;
  if (!p) return null;

  const rate = kind === 'mover' ? p.weekly.mover : p.weekly.smallVendor;
  if (rate == null) return null;
  const fmt = (n: number) => `${p.currencySymbol}${Number(n).toLocaleString()}`;

  return (
    <Card className="mb-md">
      <View className="flex-row items-center">
        <View className="h-11 w-11 items-center justify-center rounded-full" style={{ backgroundColor: color.brand[50] }}>
          <MaterialCommunityIcons name="tag-heart-outline" size={20} color={color.brand[500]} />
        </View>
        <View className="ml-md flex-1">
          <Text className="text-base font-semibold">{p.trialDays} days free, then {fmt(rate)}/week</Text>
          <Text className="mt-0.5 text-xs text-text-secondary">
            {kind === 'mover'
              ? 'Keep 100% of every fare, fee and tip — Swift never takes a commission.'
              : `Keep 100% of every sale — no commission, ever.${p.weekly.largeVendor != null ? ` Large catalogues (1000+ items) ${fmt(p.weekly.largeVendor)}/week.` : ''}`}
          </Text>
        </View>
      </View>
    </Card>
  );
}
