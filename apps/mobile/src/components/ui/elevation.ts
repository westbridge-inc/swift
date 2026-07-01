import type { ViewStyle } from 'react-native';

/**
 * RN shadow styles — the single source of depth in the app (the web side uses
 * the CSS `shadow` tokens; React Native needs object form). Three tiers: resting
 * `card`, lifted `raised`, and `floating` for photo-led hero cards that should
 * sit clearly above the surface. Use via `<Card elevation="raised">` or directly.
 */
export const elevation: Record<'card' | 'raised' | 'floating', ViewStyle> = {
  card: { shadowColor: '#0B0B0F', shadowOpacity: 0.05, shadowRadius: 16, shadowOffset: { width: 0, height: 6 }, elevation: 2 },
  raised: { shadowColor: '#000', shadowOpacity: 0.08, shadowRadius: 12, shadowOffset: { width: 0, height: 4 }, elevation: 3 },
  floating: { shadowColor: '#0B0B0F', shadowOpacity: 0.16, shadowRadius: 20, shadowOffset: { width: 0, height: 10 }, elevation: 8 },
};
