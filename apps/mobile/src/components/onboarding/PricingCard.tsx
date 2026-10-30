import { View } from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { color, radius, space } from '@swift/ui';
import { Card, T } from '../../kit';
import { usePartnerPricing } from '../../hooks/verification';
import { useAuthStore } from '../../stores/authStore';
import { moneyIn } from '../../lib/money';
import { bandTrialDays, moverQuote, vendorQuote, type MoverTier, type PartnerVendorType } from '../../lib/partnerPricing';

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
 *  valid quote there is no card: never a zero, never a conflated figure, and
 *  never a figure the last fetch failed to confirm — the signup gate refuses
 *  that too, so the card and the disabled button never disagree. */
export function PricingCard(props: PricingCardProps) {
  const user = useAuthStore((s) => s.user) as { countryCode?: string } | null;
  const pricing = usePartnerPricing(user?.countryCode);
  const p = pricing.data;
  if (!p || pricing.isError) return null;
  const fee = (n: number) => moneyIn(n, p.currencyCode);

  let rate: number;
  let detail: string;
  if (props.kind === 'mover') {
    const quote = moverQuote(p, props.vehicleType);
    if (!quote) return null;
    rate = quote.rate;
    detail = `${MOVER_RATE_LABEL[quote.tier]} rate · Keep 100% of every fare, fee and tip — no commission on orders.`;
  } else {
    const quote = vendorQuote(p, props.vendorType);
    if (!quote) return null;
    rate = quote.rate;
    // [R27] The weekly re-tier is OFF on the server (apps/api/src/modules/billing/weekly-retier.ts): a new store is
    // born on the first step, whatever its catalogue, and nothing moves it. So the card quotes that one rate and
    // says it does not move with the catalogue; the larger steps' fees are not this store's and are not listed.
    // The card test pins the server flag: turning the re-tier back on must revisit these words.
    // [DEPT-PRICE · owner 29 Oct 2026] A step with its own free trial (7 days for a NEW department store) says so,
    // from the server's number: the headline keeps the trial every new store starts on.
    const trials = quote.ladder
      .slice(1)
      .filter((step) => bandTrialDays(step, p.trialDays) !== p.trialDays)
      .map((step) => ` A new store with ${step.minItems.toLocaleString()}+ active items when Swift approves it gets ${bandTrialDays(step, p.trialDays)} days free.`);
    detail =
      quote.tier === 'service'
        ? 'Service provider rate · Keep 100% of every booking — no commission on orders.'
        : `Keep 100% of every sale — no commission on orders. Today this rate does not change as your catalogue grows.${trials.join('')}`;
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
