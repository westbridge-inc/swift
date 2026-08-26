import { color, font, fontSize, lineHeight, space, radius, shadow, typeScale } from './tokens';

/**
 * The NativeWind / Tailwind token map — `theme.extend` for apps/mobile's
 * tailwind config (and any web Tailwind config). Components reference
 * token-named classes (`bg-brand-500`, `text-text-primary`, `rounded-lg`),
 * never raw hex. This is the bridge from tokens.ts to className styling.
 */
export const swiftTailwindTheme = {
  colors: {
    brand: color.brand,
    white: color.white,
    surface: color.surface,
    text: color.text,
    border: color.border,
    success: color.success,
    error: color.error,
    warning: color.warning,
    info: color.info,
    star: color.star,
    soft: color.soft,
    skeleton: color.skeleton,
  },
  fontFamily: {
    display: [font.display, 'System', 'sans-serif'],
    body: [font.body, 'System', 'sans-serif'],
    sans: [font.body, 'System', 'sans-serif'],
  },
  fontSize: {
    micro: [`${fontSize.micro}px`, `${lineHeight.micro}px`],
    xs: [`${fontSize.xs}px`, `${lineHeight.xs}px`],
    sm: [`${fontSize.sm}px`, `${lineHeight.sm}px`],
    base: [`${fontSize.base}px`, `${lineHeight.base}px`],
    lg: [`${fontSize.lg}px`, `${lineHeight.lg}px`],
    xl: [`${fontSize.xl}px`, `${lineHeight.xl}px`],
    '2xl': [`${fontSize['2xl']}px`, `${lineHeight['2xl']}px`],
    '3xl': [`${fontSize['3xl']}px`, `${lineHeight['3xl']}px`],
    '4xl': [`${fontSize['4xl']}px`, `${lineHeight['4xl']}px`],
    // The two deck-mandated one-off steps — see typeScale's note; rare on purpose.
    payAmount: [`${typeScale.payAmount.fontSize}px`, `${typeScale.payAmount.lineHeight}px`],
    accountNumber: [`${typeScale.accountNumber.fontSize}px`, `${typeScale.accountNumber.lineHeight}px`],
  },
  borderRadius: {
    sm: `${radius.sm}px`,
    md: `${radius.md}px`,
    lg: `${radius.lg}px`,
    xl: `${radius.xl}px`,
    full: '9999px',
  },
  spacing: Object.fromEntries(Object.entries(space).map(([k, v]) => [k, `${v}px`])) as Record<
    keyof typeof space,
    string
  >,
  boxShadow: {
    card: shadow.card,
    raised: shadow.raised,
  },
} as const;
