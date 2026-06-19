import type { ViewStyle } from 'react-native';

/**
 * RN shadow styles — the single source of depth in the app (the web side uses
 * the CSS `shadow` tokens; React Native needs object form). Two tiers: resting
 * `card` and lifted `raised`. Use via `<Card elevation="raised">` or directly.
 */
export const elevation: Record<'card' | 'raised', ViewStyle> = {
  card: { shadowColor: '#000', shadowOpacity: 0.06, shadowRadius: 8, shadowOffset: { width: 0, height: 2 }, elevation: 2 },
  raised: { shadowColor: '#000', shadowOpacity: 0.08, shadowRadius: 12, shadowOffset: { width: 0, height: 4 }, elevation: 3 },
};
