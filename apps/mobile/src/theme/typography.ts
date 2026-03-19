import { Platform } from 'react-native';

const fontFamily = Platform.select({ ios: 'System', android: 'Roboto', default: 'System' });

export const typography = {
  h1: { fontFamily, fontSize: 32, fontWeight: '700' as const, lineHeight: 40 },
  h2: { fontFamily, fontSize: 24, fontWeight: '700' as const, lineHeight: 32 },
  h3: { fontFamily, fontSize: 20, fontWeight: '600' as const, lineHeight: 28 },
  body: { fontFamily, fontSize: 16, fontWeight: '400' as const, lineHeight: 24 },
  bodyBold: { fontFamily, fontSize: 16, fontWeight: '600' as const, lineHeight: 24 },
  caption: { fontFamily, fontSize: 14, fontWeight: '400' as const, lineHeight: 20 },
  small: { fontFamily, fontSize: 12, fontWeight: '400' as const, lineHeight: 16 },
  button: { fontFamily, fontSize: 16, fontWeight: '600' as const, lineHeight: 20 },
  price: { fontFamily, fontSize: 18, fontWeight: '700' as const, lineHeight: 24 },
} as const;
