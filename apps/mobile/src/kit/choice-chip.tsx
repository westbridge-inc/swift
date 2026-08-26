import { type StyleProp, type ViewStyle } from 'react-native';
import { color, radius, space } from '@swift/ui';
import { T } from './text';
import { PressableScale } from './pressable-scale';

/**
 * The one selected-option pill. Single source of truth for the premium
 * selected state — a SOLID brand fill (never a washed-out tint) — shared by
 * the taxi tiers and courier size/speed choices so selection reads the same
 * everywhere.
 *
 * [DRIFT-09 · the ChoiceChip/Chip decision] These are ONE role (a selectable
 * option pill) wearing two treatments today: Chip carries the 48pt list-chip
 * geometry, ChoiceChip carries the solid-fill selected state. The recorded
 * decision: they unify into Chip at the screen-rebuild wave, with THIS solid
 * fill as the surviving selected treatment — collapsing them earlier would
 * force TaxiScreen/CourierScreen (both slated for rebuild) to move first.
 * Until then this port keeps the legacy API so the folder can die on time.
 */
export function ChoiceChip({
  label,
  active,
  onPress,
  full,
  style,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
  /** Stretch to fill its row (equal-width options). */
  full?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <PressableScale
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      accessibilityLabel={label}
      style={[
        {
          borderRadius: radius.sm,
          borderWidth: 1,
          paddingHorizontal: space.lg,
          paddingVertical: space.sm,
        },
        full ? { flex: 1, alignItems: 'center' } : null,
        active
          ? { backgroundColor: color.brand[500], borderColor: color.brand[500] }
          : { backgroundColor: color.surface.base, borderColor: color.border.subtle },
        style,
      ]}
    >
      <T variant="body" weight={active ? 'semibold' : undefined} style={{ color: active ? color.white : color.text.secondary }}>
        {label}
      </T>
    </PressableScale>
  );
}

/** Shared selected-surface treatment (e.g. the taxi tier rows): the brand
 *  fill for the active state, nothing for the neutral one — callers keep
 *  their own neutral border/background tokens. */
export const choiceSurfaceStyle = (active: boolean): ViewStyle | undefined =>
  active ? { backgroundColor: color.brand[500], borderColor: color.brand[500] } : undefined;
