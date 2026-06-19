/**
 * @swift/ui — Canonical design tokens.
 * ==================================================================
 * THE single source of truth for every colour, font, size, space, radius and
 * shadow in the product. Rebrand = edit THIS file only. If a raw hex / size
 * ever appears inside a component, that is a bug — use the token.
 *
 * Identity: Swift **red (#E8192C) on white**. No gold, no orange. Neutral grays
 * for everything structural; functional colours carry reserved meanings only.
 *
 * Consumers:
 *   - apps/mobile (React Native / NativeWind) -> via tailwind.ts (theme map)
 *   - web / global.css                        -> via css.ts (CSS custom props)
 */

export const APP_NAME = 'Swift' as const;
export const BRAND_REGION = 'GY' as const;

/** §Colour — red identity + neutral surfaces. Red is an ACCENT, never flooded. */
export const color = {
  brand: {
    50: '#FFF2F3', // red tint — bg-brand-50 surfaces
    100: '#FBD7DB',
    200: '#F4A6AD',
    300: '#ED7480',
    400: '#EA4555',
    500: '#E8192C', // Swift Red — identity + primary CTA
    600: '#BC1320', // Deep Red — hover/accent
    700: '#930F1A', // pressed
    800: '#6B0B13',
    900: '#45070C',
  },
  white: '#FFFFFF',
  surface: {
    base: '#FFFFFF',
    subtle: '#F7F7F8',
    elevated: '#FFFFFF', // elevate with shadow, not colour
  },
  text: {
    primary: '#16171C', // Ink
    secondary: '#6B6B6B',
    muted: '#8E8E93',
    onBrand: '#FFFFFF',
  },
  border: {
    subtle: '#E5E5EA',
    strong: '#C7C7CC',
  },
  /** Functional — RESERVED meanings; never reused for branding/decoration. */
  success: '#1DA851',
  error: '#E5342B',
  warning: '#F59E0B',
} as const;

/** §Type — Space Grotesk (display) + Inter (body). */
export const font = {
  display: 'SpaceGrotesk',
  body: 'Inter',
} as const;

export const fontSize = {
  xs: 12,
  sm: 14,
  base: 16,
  lg: 18,
  xl: 20,
  '2xl': 24,
  '3xl': 32,
} as const;

export const lineHeight = {
  xs: 16,
  sm: 20,
  base: 24,
  lg: 24,
  xl: 28,
  '2xl': 32,
  '3xl': 40,
} as const;

export const fontWeight = {
  regular: '400',
  medium: '500',
  semibold: '600',
  bold: '700',
} as const;

/** §Space + radius (ported from theme/spacing.ts) — rounded, friendly. */
export const space = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  '2xl': 24,
  '3xl': 32,
  '4xl': 40,
  '5xl': 48,
} as const;

export const radius = {
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  full: 9999,
} as const;

/** §Elevation — shadow not colour. */
export const shadow = {
  card: '0px 1px 3px rgba(0,0,0,0.08)',
  raised: '0px 6px 16px rgba(0,0,0,0.12)',
} as const;
