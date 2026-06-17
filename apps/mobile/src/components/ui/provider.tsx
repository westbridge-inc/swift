import { View } from 'react-native';
import type { ReactNode } from 'react';

/**
 * Root UI provider. Sets the white app surface and is the seam where real
 * Gluestack v3 overlay/toast context slots in (added via `npx gluestack-ui add`
 * on a dev machine). The app imports `global.css` once in App.tsx.
 */
export function GluestackUIProvider({ children }: { children: ReactNode }) {
  return <View className="flex-1 bg-surface-base">{children}</View>;
}
