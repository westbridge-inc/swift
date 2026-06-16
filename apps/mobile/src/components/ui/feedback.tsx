import { ActivityIndicator, View, type ViewProps } from 'react-native';
import { color } from '@swift/ui';
import { cn } from './cn';

export function Spinner({ size = 'small' }: { size?: 'small' | 'large' }) {
  return <ActivityIndicator size={size} color={color.brand[500]} />;
}

/** Neutral placeholder block for loading states. */
export function Skeleton({ className, ...props }: ViewProps & { className?: string }) {
  return <View className={cn('bg-surface-subtle rounded-md', className)} {...props} />;
}
