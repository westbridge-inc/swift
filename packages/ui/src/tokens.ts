/**
 * @swift/ui — Canonical design tokens.
 * ==================================================================
 * THE single source of truth for every colour, font, size, space, radius and
 * shadow in the product. Rebrand = edit THIS file only. If a raw hex / size
 * ever appears inside a component, that is a bug — use the token.
 *
 * Identity: **Indian Red** — Michael Harding Indian Red No. 123 (pigment PR101,
 * a deep cool iron-oxide red with a purplish undertone) translated for screens:
 * brand #803B3B on warm off-white paper (#FBFBF9), white cards, soft tint
 * #F5EBEC. NOT the light CSS `indianred` (#CD5C5C). Layout/structure follows
 * the Super Food kit; every kit colour is swapped for this set.
 *
 * Colour discipline (brand is red, so): `error` (#DC2626) is ONLY for genuine
 * error/failed states, always paired with an icon or label — never decoration,
 * and brand NEVER signals an error. `warning` amber doubles as the star/rating
 * hue. `success` = paid/delivered/in-stock.
 *
 * Consumers:
 *   - apps/mobile (React Native / NativeWind) -> via tailwind.ts (theme map)
 *   - web / global.css                        -> via css.ts (CSS custom props)
 */

export const APP_NAME = 'Swift' as const;
export const BRAND_REGION = 'GY' as const;

/**
 * §Colour — **Indian Red** (#803B3B) on warm paper (#FBFBF9) with white cards.
 * Every brand token — NativeWind `bg-brand-*` / `text-brand-*` classes AND
 * `color.brand[…]` read in JS — draws from this single ramp. 500 = primary;
 * 600 = the locked deep (#5C2A2C) for pressed/emphasis; 50 = the locked soft
 * tint (#F5EBEC) for chips, selected rows and icon circles.
 */
type BrandRamp = Record<50 | 100 | 200 | 300 | 400 | 500 | 600 | 700 | 800 | 900, string>;

const BRAND_INDIAN_RED: BrandRamp = {
  50: '#F5EBEC', // brandSoft — tints, selected rows, secondary buttons, icon chips
  100: '#EAD8D8',
  200: '#D8B2B3',
  300: '#C08A8B',
  400: '#A05F60',
  500: '#803B3B', // brand primary — CTAs, active tabs, prices, links, the mark
  600: '#5C2A2C', // brandDeep — pressed states, emphasis text on light
  700: '#482123',
  800: '#351819',
  900: '#231010',
};

export const color = {
  brand: BRAND_INDIAN_RED,
  white: '#FFFFFF',
  /** Masthead wash — brand 500 → 600, replacing the kit's golden gradient. */
  masthead: { from: '#803B3B', to: '#5C2A2C' },
  surface: {
    base: '#FFFFFF', // cards
    subtle: '#FBFBF9', // paper — the app background
    elevated: '#FFFFFF', // elevate with shadow, not colour
  },
  text: {
    primary: '#211A1A', // ink
    secondary: '#786C6C', // muted
    muted: '#B3A8A8', // captions/placeholders/inactive (nav inactive)
    onBrand: '#FFFFFF',
  },
  border: {
    subtle: '#EAE2E1', // line — borders, dividers
    strong: '#D9CDCC',
  },
  /** Functional — RESERVED meanings; `error` is genuine error/failed states
   *  ONLY, always with an icon or label; brand never signals an error.
   *  `warning` amber doubles as the star/rating hue. */
  success: '#16A34A',
  error: '#DC2626',
  warning: '#F59E0B',
};

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

/** §Motion — durations (ms) + spring presets + press-scale values, so animation
 *  timing is a token (never a magic number scattered across screens). Consumed
 *  by PressableScale, entrance animations, and screen transitions. */
export const motion = {
  duration: { instant: 90, fast: 140, base: 240, slow: 380 },
  scale: { press: 0.97, pressStrong: 0.94 },
  spring: {
    press: { damping: 20, stiffness: 350, mass: 0.6 },
    entrance: { damping: 18, stiffness: 170, mass: 0.9 },
  },
} as const;
