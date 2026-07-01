import { View, type ViewProps, type StyleProp, type ViewStyle } from 'react-native';
import { cn } from './cn';
import { elevation as elevationStyles } from './elevation';

/** White, rounded, elevated surface (shadow not colour). `elevation` picks the
 *  resting `card` tier (default) or the lifted `raised` tier. */
export function Card({
  className,
  elevation = 'card',
  style,
  ...props
}: ViewProps & { className?: string; elevation?: 'card' | 'raised'; style?: StyleProp<ViewStyle> }) {
  return (
    <View
      className={cn('bg-surface-base rounded-2xl border border-border-subtle p-lg', className)}
      style={[elevationStyles[elevation], style]}
      {...props}
    />
  );
}
