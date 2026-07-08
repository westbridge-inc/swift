/**
 * @swift/ui — Canonical design tokens.
 * ==================================================================
 * THE single source of truth for every colour, font, size, space, radius and
 * shadow in the product. Rebrand = edit THIS file only. If a raw hex / size
 * ever appears inside a component, that is a bug — use the token.
 *
 * Identity: Swift **Indian Red (#803B3B) on off-white paper**. Brand is Michael
 * Harding Indian Red No. 123 (pigment PR101 — deep cool iron-oxide red, purplish
 * undertone), NOT the light CSS `indianred`. Warm neutrals for everything
 * structural; functional colours carry reserved meanings only.
 *
 * Red discipline (brand is red, so): `error` is ONLY for genuine error/failed
 * states, always paired with an icon or label — never decoration. Brand never
 * signals an error.
 *
 * Consumers:
 *   - apps/mobile (React Native / NativeWind) -> via tailwind.ts (theme map)
 *   - web / global.css                        -> via css.ts (CSS custom props)
 */

export const APP_NAME = 'Swift' as const;
export const BRAND_REGION = 'GY' as const;

/**
 * §Colour — one Swift identity: **Indian Red** (#803B3B) on off-white paper.
 * Every brand token — NativeWind `bg-brand-*` / `text-brand-*` classes AND
 * `color.brand[…]` read in JS — draws from this single ramp. Brand is an ACCENT,
 * never flooded. Ramp anchors: 50 = brandSoft (tints/selected rows), 500 = brand
 * (buttons/active tabs/links/the mark), 700 = brandDeep (pressed states,
 * emphasis text on light); in-between stops are interpolated to keep the ramp.
 */
type BrandRamp = Record<50 | 100 | 200 | 300 | 400 | 500 | 600 | 700 | 800 | 900, string>;

const BRAND_INDIAN_RED: BrandRamp = {
  50: '#F5EBEC', // brandSoft — tints, selected rows, secondary buttons
  100: '#E0CBCC',
  200: '#C6A5A5',
  300: '#AC7E7E',
  400: '#955B5B',
  500: '#803B3B', // brand — Indian Red No. 123 (PR101): primary CTA, active tabs, links, the Swift mark
  600: '#6E3234',
  700: '#5C2A2C', // brandDeep — pressed states, emphasis text on light
  800: '#4A2225',
  900: '#391A1E',
};

export const color = {
  brand: BRAND_INDIAN_RED,
  white: '#FFFFFF',
  surface: {
    base: '#FFFFFF', // cards
    subtle: '#FBFBF9', // paper — the app background tone
    elevated: '#FFFFFF', // elevate with shadow, not colour
  },
  text: {
    primary: '#211A1A', // ink
    secondary: '#786C6C', // muted
    muted: '#9C9090', // captions/placeholders — lighter step of `muted`, same warm cast
    onBrand: '#FFFFFF',
  },
  border: {
    subtle: '#EAE2E1', // line
    strong: '#D9CECD', // darker step of `line`, same warm cast
  },
  /** Functional — RESERVED meanings; never reused for branding/decoration.
   *  `error` = the Part-3 `danger`: genuine error/failed states ONLY, always
   *  with an icon or label. */
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
