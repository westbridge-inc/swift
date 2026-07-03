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
  card: { shadowColor: '#0B0B0F', shadowOpacity: 0.08, shadowRadius: 14, shadowOffset: { width: 0, height: 6 }, elevation: 3 },
  raised: { shadowColor: '#0B0B0F', shadowOpacity: 0.12, shadowRadius: 16, shadowOffset: { width: 0, height: 8 }, elevation: 5 },
  floating: { shadowColor: '#0B0B0F', shadowOpacity: 0.22, shadowRadius: 24, shadowOffset: { width: 0, height: 12 }, elevation: 10 },
};
