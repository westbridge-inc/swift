import { Pressable, View } from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { color, radius, space } from '@swift/ui';
import { T } from '../../kit';
import { moneyIn } from '../../lib/money';
import type { FeeTick } from '../../lib/partnerPricing';

/**
 * [COORD ruling 22 Oct 2026 · row 628] The weekly fee, said where a partner signs: the amount
 * the server quotes for THIS vehicle or business, then the server's own words — what it covers,
 * when it starts (only after approval: nothing is paid at sign-up), how it is paid (MMG's
 * checkout page in the app) and the 14-day rule for price changes — and the unticked
 * "I understand the weekly fee" tick, beside the agreement. The server records the tick, anchored
 * to these words, with the amount. With no words served (an older API) there is nothing to show.
 */
export function WeeklyFeeTerms({ fee, ticked, onToggle }: {
  fee: FeeTick;
  ticked: boolean;
  onToggle: () => void;
}) {
  if (fee.kind !== 'tick') return null;
  const { terms, ack } = fee;
  return (
    <View style={{ marginTop: space.md, gap: space.sm, padding: space.md, borderRadius: radius.lg, borderWidth: 1, borderColor: color.border.subtle }}>
      <T variant="label" weight="semibold">Your weekly fee: {moneyIn(ack.amount, ack.currencyCode)}/week</T>
      {terms.items.map((item) => (
        <T key={item.heading} variant="caption" tone="muted">
          <T variant="caption" weight="semibold">{item.heading}: </T>
          {item.text}
        </T>
      ))}
      <Pressable
        accessibilityRole="checkbox"
        accessibilityState={{ checked: ticked }}
        accessibilityLabel={terms.tick}
        onPress={onToggle}
        style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm, marginTop: space.xs, minHeight: 48 }}
      >
        <MaterialCommunityIcons
          name={ticked ? 'checkbox-marked' : 'checkbox-blank-outline'}
          size={22}
          color={ticked ? color.brand[500] : color.text.muted}
        />
        <T variant="label" style={{ flexShrink: 1 }}>{terms.tick}</T>
      </Pressable>
    </View>
  );
}
