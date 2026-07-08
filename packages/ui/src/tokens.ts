/**
 * @swift/ui — Canonical design tokens.
 * ==================================================================
 * THE single source of truth for every colour, font, size, space, radius and
 * shadow in the product. Rebrand = edit THIS file only. If a raw hex / size
 * ever appears inside a component, that is a bug — use the token.
 *
 * Identity: the **Super Food kit palette, verbatim** — vivid orange (#FE8C00)
 * primary, warm golden-orange gradient mastheads (#F0B41A → #E47916), gold
 * (#FFC228) for stars/ratings, near-black ink (#101010) on white and #F5F5F7.
 * These are the exact values decoded from the purchased kit file, so the app
 * reads like the kit's preview. (Prior identities — Swift red #E8192C, Indian
 * Red #803B3B — are one values-swap away in THIS file if direction changes.)
 *
 * Colour discipline: `error` is ONLY for genuine error/failed states, always
 * paired with an icon or label — never decoration. Brand never signals an
 * error; gold is ratings/highlights, not warnings copy.
 *
 * Consumers:
 *   - apps/mobile (React Native / NativeWind) -> via tailwind.ts (theme map)
 *   - web / global.css                        -> via css.ts (CSS custom props)
 */

export const APP_NAME = 'Swift' as const;
export const BRAND_REGION = 'GY' as const;

/**
 * §Colour — the kit's palette: **vivid orange** (#FE8C00) on white/#F5F5F7.
 * Every brand token — NativeWind `bg-brand-*` / `text-brand-*` classes AND
 * `color.brand[…]` read in JS — draws from this single ramp. 500 = the kit
 * primary; 600/700 follow the kit's masthead-gradient deep end; 50–100 are the
 * kit's warm tints.
 */
type BrandRamp = Record<50 | 100 | 200 | 300 | 400 | 500 | 600 | 700 | 800 | 900, string>;

const BRAND_KIT_ORANGE: BrandRamp = {
  50: '#FFF5EA', // warm tint — chips, selected rows, icon circles
  100: '#FFE8CC',
  200: '#FFD199',
  300: '#FEB966',
  400: '#FEA133',
  500: '#FE8C00', // kit primary — CTAs, active tabs, prices, the mark
  600: '#E47916', // kit masthead-gradient deep end — pressed, emphasis
  700: '#B96200',
  800: '#8F4C00',
  900: '#663600',
};

export const color = {
  brand: BRAND_KIT_ORANGE,
  white: '#FFFFFF',
  /** Kit masthead gradient — decoded verbatim from the Home V1 canopy. */
  masthead: { from: '#F0B41A', to: '#E47916' },
  surface: {
    base: '#FFFFFF', // cards + light screens
    subtle: '#F5F5F7', // the kit's cool-gray app background
    elevated: '#FFFFFF', // elevate with shadow, not colour
  },
  text: {
    primary: '#101010', // kit ink
    secondary: '#878787', // kit muted
    muted: '#C2C2C2', // captions/placeholders/inactive (kit nav inactive)
    onBrand: '#FFFFFF',
  },
  border: {
    subtle: '#EDEDED', // kit hairline
    strong: '#D9D9D9',
  },
  /** Functional — kit set. RESERVED meanings; `error` is genuine error/failed
   *  states ONLY, always with an icon or label. `warning` is the kit gold —
   *  stars/ratings/highlights. */
  success: '#50CD89',
  error: '#F14141',
  warning: '#FFC228',
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
