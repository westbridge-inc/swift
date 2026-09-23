import { View } from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { color, radius, space } from '@swift/ui';
import { Card, T } from '../../kit';
import { usePartnerPricing } from '../../hooks/verification';
import { useAuthStore } from '../../stores/authStore';
import { moneyIn } from '../../lib/money';
import { moverQuote, vendorQuote, type MoverTier, type PartnerVendorType } from '../../lib/partnerPricing';

/** Who the rate is for, in the partner's own words. */
const MOVER_RATE_LABEL: Record<MoverTier, string> = {
  courier: 'Delivery & courier rider',
  courierHeavy: 'Heavy delivery (canter or truck)',
  taxi: 'Taxi driver',
};

export type PricingCardProps =
  | { kind: 'mover'; vehicleType: string | null | undefined }
  | { kind: 'vendor'; vendorType: PartnerVendorType };

/** The SaaS pitch, price on the door: partners see exactly what Swift costs
 *  BEFORE they commit — N days free, then THEIR weekly fee, zero commission.
 *  The fee is the server's quote for this vehicle or this business — the same
 *  number signup writes — from the country the account signed up in. With no
 *  valid quote there is no card: never a zero, never a conflated figure. */
export function PricingCard(props: PricingCardProps) {
  const user = useAuthStore((s) => s.user) as { countryCode?: string } | null;
  const pricing = usePartnerPricing(user?.countryCode);
  const p = pricing.data;
  if (!p) return null;
  const fee = (n: number) => moneyIn(n, p.currencyCode);

  let rate: number;
  let detail: string;
  if (props.kind === 'mover') {
    const quote = moverQuote(p, props.vehicleType);
    if (!quote) return null;
    rate = quote.rate;
    detail = `${MOVER_RATE_LABEL[quote.tier]} rate · Keep 100% of every fare, fee and tip — Swift never takes a commission.`;
  } else {
    const quote = vendorQuote(p, props.vendorType);
    if (!quote) return null;
    rate = quote.rate;
    // The steps above the one a new store starts on, exactly as the server
    // bounds them; the weekly re-tier moves a store between them on its own.
    const steps = quote.ladder
      .slice(1)
      .map((step, i) => `${step.minItems.toLocaleString()}+${i === 0 ? ' active items' : ''} ${fee(step.rate)}/week`);
    detail =
      quote.tier === 'service'
        ? 'Service provider rate · Keep 100% of every booking — no commission, ever.'
        : `Keep 100% of every sale — no commission, ever.${steps.length ? ` Your rate moves automatically as your catalogue grows: ${steps.join(' · ')}.` : ''}`;
  }

  return (
    <Card style={{ marginBottom: space.md }}>
      <View style={{ flexDirection: 'row', alignItems: 'center' }}>
        <View style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center', borderRadius: radius.full, backgroundColor: color.brand[50] }}>
          <MaterialCommunityIcons name="tag-heart-outline" size={20} color={color.brand[500]} />
        </View>
        <View style={{ marginLeft: space.md, flex: 1 }}>
          <T variant="body" weight="semibold">{p.trialDays} days free, then {fee(rate)}/week</T>
          <T variant="caption" tone="muted" style={{ marginTop: 2 }}>
            {detail}
          </T>
        </View>
      </View>
    </Card>
  );
}
