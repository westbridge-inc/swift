import { Text } from './text';
import { PressableScale } from './pressable-scale';
import { cn } from './cn';

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
        active ? 'border-brand-500 bg-brand-500' : 'border-border-subtle bg-surface-base',
        className,
      )}
    >
      <Text className={active ? 'font-semibold text-white' : 'text-text-secondary'}>{label}</Text>
    </PressableScale>
  );
}

/** Shared classes for richer selected surfaces (e.g. the taxi tier rows). */
export const choiceSurface = (active: boolean) =>
  active ? 'border-brand-500 bg-brand-500' : 'border-border-subtle bg-surface-base';
