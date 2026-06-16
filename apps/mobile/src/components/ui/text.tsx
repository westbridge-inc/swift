import { Text as RNText, type TextProps } from 'react-native';
import { cn } from './cn';

type Props = TextProps & { className?: string };

/** Body text — Inter, neutral primary by default. */
export function Text({ className, ...props }: Props) {
  return <RNText className={cn('font-body text-base text-text-primary', className)} {...props} />;
}

type HeadingProps = Props & { size?: 'lg' | 'xl' | '2xl' | '3xl' };
const HEADING_SIZE: Record<NonNullable<HeadingProps['size']>, string> = {
  lg: 'text-lg',
  xl: 'text-xl',
  '2xl': 'text-2xl',
  '3xl': 'text-3xl',
};

/** Display heading — Space Grotesk, bold. */
export function Heading({ className, size = 'xl', ...props }: HeadingProps) {
  return <RNText className={cn('font-display font-bold text-text-primary', HEADING_SIZE[size], className)} {...props} />;
}
