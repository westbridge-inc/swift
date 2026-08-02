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
 * and brand NEVER signals an error (the two-reds law). `star` is the rating
 * hue; `warning` is a readable burnt amber for cautions. `success` =
 * paid/delivered/in-stock, in small doses.
 *
 * Design-100× role map (spec Part 9 ↔ this file — indices are LOCKED, mapped
 * not renumbered): spec brand-600 ≡ brand[500] · spec brand-700 ≡ brand[600]
 * · spec brand-100 tile ≡ brand[50] · ink-primary/secondary/tertiary ≡
 * text.primary/secondary/muted · surface base/raised/sunken ≡
 * surface.subtle/base/sunken.
 *
 * Consumers:
 *   - apps/mobile (React Native / NativeWind) -> via tailwind.ts (theme map)
 *   - web / global.css                        -> via css.ts (CSS custom props)
 */

export const APP_NAME = 'Swift' as const;

/** Alpha over any token hex — THE way to derive glows, scrims and tints
 *  (never a raw rgba literal in app code). */
export function withAlpha(hex: string, alpha: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}
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
    sunken: '#F7F5F3', // grouped sections / tracks — 3% brand tint on paper
    onBrand: 'rgba(255,255,255,0.14)', // chrome chips sitting on the maroon header
  },
  text: {
    primary: '#211A1A', // ink — 16.5:1 on paper
    secondary: '#786C6C', // muted — 4.9:1 on paper
    muted: '#948888', // placeholders/inactive ONLY, never essential — 3.3:1 on paper
    onBrand: '#FFFFFF', // 8.1:1 on brand[500]
  },
  border: {
    subtle: '#EAE2E1', // line — borders, dividers
    strong: '#D9CDCC',
  },
  /** Functional — RESERVED meanings; `error` is genuine error/failed states
   *  ONLY, always with an icon or label; brand never signals an error.
   *  Hues are harmonized to the maroon (no stock-palette greens/ambers). */
  success: '#1E6E5A', // deep viridian — delivered/open/paid; 5.9:1 on paper
  error: '#DC2626', // 4.7:1 on paper; clearly hotter than brand side-by-side
  errorDeep: '#B91C1C', // pressed state of destructive controls
  warning: '#B45309', // burnt amber — cautions/cash-float; 4.9:1 on paper
  info: '#3B5B7A', // restrained slate — neutral notices; 6.8:1 on paper
  star: '#F59E0B', // rating hue ONLY — decorative, never carries meaning alone
  /** Soft tints for status chips/badges (text on them uses the full hue). */
  soft: {
    success: '#E9F1EF',
    warning: '#F8EEE6',
    danger: '#FCEEEE',
    info: '#EBEFF2',
  },
  /** Focus ring for keyboard / switch-access — visible on every surface. */
  focusRing: '#803B3B',
  /** Scrim behind sheets/dialogs — ink at 40%. */
  scrim: 'rgba(33,26,26,0.4)',
  /** The media treatment (ads, hero imagery) — THE three values every photo
   *  surface uses, so imagery dims, chips float and text lifts identically
   *  everywhere: panel overlay · floating chip (warm ink, 5.3:1 white-on-chip
   *  over a worst-case white photo) · on-media text shadow. */
  mediaScrim: 'rgba(0,0,0,0.22)',
  mediaChip: 'rgba(21,16,16,0.62)',
  mediaInkShadow: 'rgba(0,0,0,0.6)',
  /** Skeleton loading shapes — brand-tinted, calm. */
  skeleton: {
    base: '#F7F3F3',
    highlight: '#F0E7E7',
  },
};

/**
 * §Type — **Bricolage Grotesque** (display + every number that matters) over
 * **Hanken Grotesk** (body). Bricolage's woodtype DNA echoes hand-painted
 * Georgetown shop signage; Hanken's tall x-height holds 13dp on a 720p Android
 * in sunlight. Numerals: Bricolage carries `tnum` (verified in the shipped
 * TTFs — Hanken does not), so ALL money/data numbers render in the display
 * face with tabular figures: money speaks in the brand's voice and never
 * wobbles. RN selects fonts by family name — one family per weight, never
 * fontWeight (registered in App.tsx).
 */
export const font = {
  display: 'Bricolage', // Bricolage Grotesque 700
  displaySemiBold: 'BricolageSemiBold', // Bricolage Grotesque 600
  body: 'Hanken', // Hanken Grotesk 400
  bodyMedium: 'HankenMedium', // 500
  bodySemiBold: 'HankenSemiBold', // 600
  bodyBold: 'HankenBold', // 700
} as const;

/**
 * Size keys are the Design-100× scale (Part 9.2). Legacy keys map onto the
 * nearest step so unmigrated `text-*` classes land on-scale automatically:
 * micro 11 · xs/sm 13 (caption) · base 15 (body) · lg 17 (heading) ·
 * xl/2xl 22 (title) · 3xl 28 (display) · 4xl 34 (display-xl).
 */
export const fontSize = {
  micro: 11,
  xs: 13,
  sm: 13,
  base: 15,
  lg: 17,
  xl: 22,
  '2xl': 22,
  '3xl': 28,
  '4xl': 34,
} as const;

export const lineHeight = {
  micro: 14,
  xs: 18,
  sm: 18,
  base: 22,
  lg: 24,
  xl: 28,
  '2xl': 28,
  '3xl': 32,
  '4xl': 38,
} as const;

export const fontWeight = {
  regular: '400',
  medium: '500',
  semibold: '600',
  bold: '700',
} as const;

/**
 * The named type steps (Design-100× Part 9.2) — TextStyle-shaped, consumed by
 * the kit `T` component and any bespoke text. Money is ALWAYS a `num` step.
 */
export type TypeStep = {
  fontSize: number;
  lineHeight: number;
  fontFamily: string;
  letterSpacing?: number;
  textTransform?: 'uppercase';
  fontVariant?: Array<'tabular-nums'>;
};

export const typeScale: Record<
  | 'displayXl'
  | 'display'
  | 'title'
  | 'heading'
  | 'body'
  | 'bodyStrong'
  | 'label'
  | 'caption'
  | 'micro'
  | 'numL'
  | 'numM',
  TypeStep
> = {
  displayXl: { fontSize: 34, lineHeight: 38, fontFamily: font.display, fontVariant: ['tabular-nums'] }, // hold countdown, PIN digits, hero money
  display: { fontSize: 28, lineHeight: 32, fontFamily: font.display }, // screen titles (sparingly)
  title: { fontSize: 22, lineHeight: 28, fontFamily: font.displaySemiBold }, // section headers, store name
  heading: { fontSize: 17, lineHeight: 24, fontFamily: font.bodySemiBold }, // card titles, list-item primary
  body: { fontSize: 15, lineHeight: 22, fontFamily: font.body }, // default text
  bodyStrong: { fontSize: 15, lineHeight: 22, fontFamily: font.bodySemiBold }, // inline emphasis, button labels
  label: { fontSize: 13, lineHeight: 18, fontFamily: font.bodyMedium }, // meta labels, small buttons
  caption: { fontSize: 13, lineHeight: 18, fontFamily: font.body }, // meta only, never essential info
  micro: { fontSize: 11, lineHeight: 14, fontFamily: font.bodyMedium, letterSpacing: 0.6, textTransform: 'uppercase' }, // eyebrows, AD chip, badges
  numL: { fontSize: 24, lineHeight: 28, fontFamily: font.display, fontVariant: ['tabular-nums'] }, // prices, earnings, totals
  numM: { fontSize: 17, lineHeight: 22, fontFamily: font.displaySemiBold, fontVariant: ['tabular-nums'] }, // money in lists and rows
};

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

/** §Elevation — web/CSS strings (NativeWind boxShadow classes). */
export const shadow = {
  card: '0px 1px 3px rgba(0,0,0,0.08)',
  raised: '0px 6px 16px rgba(0,0,0,0.12)',
} as const;

/**
 * §Elevation (RN) — THE one depth scale, promoted from the mobile kit.
 * Deliberately heavier than a stock scale: flat white cards on a white page
 * read "basic"; depth is part of the richer identity. Android parity decided
 * once here (`elevation` 3/5/10) — never hand-rolled per screen.
 * flat = border-only (list rows prefer `border.subtle` over shadow).
 */
export const elevation = {
  flat: { elevation: 0 },
  card: { boxShadow: '0px 6px 14px rgba(11,11,15,0.08)', elevation: 3 },
  raised: { boxShadow: '0px 8px 16px rgba(11,11,15,0.12)', elevation: 5 },
  floating: { boxShadow: '0px 12px 24px rgba(11,11,15,0.22)', elevation: 10 },
} as const;

/** §Motion — durations (ms), easings, spring presets and press values: every
 *  animation timing is a token (never a magic number in a screen). `moment`
 *  is the CAP for the one orchestrated moment a flow owns — nothing exceeds
 *  it, and reduced-motion swaps any moment for a crossfade. */
export const motion = {
  duration: { instant: 80, fast: 140, base: 220, gentle: 320, moment: 900 },
  easing: {
    /** cubic-bezier args for Easing.bezier(...) */
    standard: [0.2, 0, 0, 1],
    decelerate: [0, 0, 0, 1],
  },
  scale: { press: 0.98, pressStrong: 0.94 },
  opacity: { pressed: 0.92 },
  spring: {
    press: { damping: 20, stiffness: 350, mass: 0.6 },
    entrance: { damping: 18, stiffness: 170, mass: 0.9 },
    celebrate: { damping: 18, stiffness: 220, mass: 1 },
  },
} as const;
