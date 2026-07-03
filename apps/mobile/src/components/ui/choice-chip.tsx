import { Text } from './text';
import { PressableScale } from './pressable-scale';
import { cn } from './cn';
import { color } from '@swift/ui';

/**
 * The one selected-option pill. Single source of truth for the premium selected
 * state — a SOLID red fill (not the old washed-out `bg-brand-50` tint) — shared
 * by the taxi tiers and courier size/speed choices so selection reads the same
 * everywhere.
 */
export function ChoiceChip({
  label,
  active,
  onPress,
  full,
  className,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
  /** Stretch to fill its row (equal-width options). */
  full?: boolean;
  className?: string;
}) {
  return (
    <PressableScale
      onPress={onPress}
      className={cn(
        'rounded-lg border px-lg py-sm',
        full && 'flex-1 items-center',
        active ? '' : 'border-border-subtle bg-surface-base',
        className,
      )}
      style={active ? { backgroundColor: color.brand[500], borderColor: color.brand[500] } : undefined}
    >
      <Text className={active ? 'font-semibold text-white' : 'text-text-secondary'}>{label}</Text>
    </PressableScale>
  );
}

/** Shared selected-surface treatment (e.g. the taxi tier rows): classes for
 *  the neutral state, an inline style for the brand fill (see Button note). */
export const choiceSurface = (active: boolean) =>
  active ? '' : 'border-border-subtle bg-surface-base';
export const choiceSurfaceStyle = (active: boolean) =>
  active ? { backgroundColor: color.brand[500], borderColor: color.brand[500] } : undefined;
