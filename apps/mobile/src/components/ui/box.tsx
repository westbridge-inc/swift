import { View, type ViewProps } from 'react-native';
import { cn } from './cn';

/** Thin View wrapper so callers style with NativeWind className. */
export function Box({ className, ...props }: ViewProps & { className?: string }) {
  return <View className={cn(className)} {...props} />;
}
