import { color } from '@swift/ui';

// Legacy theme object kept for non-NativeWind references (e.g. navigator tabBar
// tints). Identity now lives in @swift/ui tokens — the accent flips to Swift red
// here so legacy refs follow without a broad rename.
export const colors = {
  light: {
    background: { primary: '#FFFFFF', secondary: '#F7F7F8', card: '#FFFFFF' },
    text: { primary: '#0A0A0A', secondary: '#6B6B6B', tertiary: '#8E8E93' },
    accent: { primary: color.brand[500], success: '#34C759', error: '#FF3B30', warning: '#FF9500' },
    border: { default: '#E5E5EA', strong: '#C7C7CC' },
  },
  dark: {
    background: { primary: '#0A0A0A', secondary: '#1C1C1E', card: '#2C2C2E' },
    text: { primary: '#FFFFFF', secondary: '#8E8E93', tertiary: '#636366' },
    accent: { primary: color.brand[500], success: '#30D158', error: '#FF453A', warning: '#FF9F0A' },
    border: { default: '#38383A', strong: '#48484A' },
  },
};

/** Legacy aliases → Swift red identity (kept to avoid a broad rename). */
export const SWIFT_ORANGE = color.brand[500];
export const SWIFT_BLACK = color.text.primary;
