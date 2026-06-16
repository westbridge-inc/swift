import { View, type ViewProps } from 'react-native';
import { cn } from './cn';

/** White, rounded, subtly-elevated surface (shadow not colour). */
export function Card({ className, ...props }: ViewProps & { className?: string }) {
  return (
    <View
      className={cn('bg-surface-base rounded-lg border border-border-subtle p-lg', className)}
      style={{ shadowColor: '#000', shadowOpacity: 0.06, shadowRadius: 8, shadowOffset: { width: 0, height: 2 }, elevation: 2 }}
      {...props}
    />
  );
}
