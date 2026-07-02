import { View, Text as RNText, type ViewProps } from 'react-native';
import { cn } from './cn';

type Props = ViewProps & { className?: string; label: string; tone?: 'brand' | 'success' | 'neutral' };

/** Small pill — used for trust/verified signals woven through the UI. */
export function Badge({ className, label, tone = 'brand', ...props }: Props) {
  const bg = tone === 'success' ? 'bg-success/10' : tone === 'neutral' ? 'bg-surface-subtle' : 'bg-brand-50';
  const fg = tone === 'success' ? 'text-success' : tone === 'neutral' ? 'text-text-secondary' : 'text-brand-600';
  return (
    <View className={cn('flex-row items-center self-start rounded-full px-2 py-1', bg, className)} {...props}>
      <RNText className={cn('font-body text-xs font-semibold', fg)}>{label}</RNText>
    </View>
  );
}
