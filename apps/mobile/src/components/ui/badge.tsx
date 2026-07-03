import { View, Text as RNText, type ViewProps } from 'react-native';
import { color } from '@swift/ui';
import { cn } from './cn';

type Props = ViewProps & { className?: string; label: string; tone?: 'brand' | 'success' | 'neutral' };

/** Small pill — used for trust/verified signals woven through the UI. */
export function Badge({ className, label, tone = 'brand', ...props }: Props) {
  const bg = tone === 'success' ? 'bg-success/10' : tone === 'neutral' ? 'bg-surface-subtle' : '';
  const fg = tone === 'success' ? 'text-success' : tone === 'neutral' ? 'text-text-secondary' : '';
  const bgStyle = tone === 'success' || tone === 'neutral' ? undefined : { backgroundColor: color.brand[50] };
  const fgStyle = tone === 'success' || tone === 'neutral' ? undefined : { color: color.brand[600] };
  return (
    <View className={cn('flex-row items-center self-start rounded-full px-2 py-1', bg, className)} style={bgStyle} {...props}>
      <RNText className={cn('font-body text-xs font-semibold', fg)} style={fgStyle}>{label}</RNText>
    </View>
  );
}
