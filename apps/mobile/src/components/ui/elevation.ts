import type { ViewStyle } from 'react-native';

/**
 * RN shadow styles — the single source of depth in the app (the web side uses
 * the CSS `shadow` tokens; React Native needs object form). Three tiers: resting
 * `card`, lifted `raised`, and `floating` for photo-led hero cards and overlaid
 * controls that must sit clearly above the surface. Deliberately heavier than a
 * default shadow scale — flat-white cards on a white page read "basic"; depth is
 * part of the richer identity.
 */
export const elevation: Record<'card' | 'raised' | 'floating', ViewStyle> = {
  card: { boxShadow: '0px 6px 14px rgba(11,11,15,0.08)', elevation: 3 },
  raised: { boxShadow: '0px 8px 16px rgba(11,11,15,0.12)', elevation: 5 },
  floating: { boxShadow: '0px 12px 24px rgba(11,11,15,0.22)', elevation: 10 },
};
