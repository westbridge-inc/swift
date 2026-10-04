/** @jsxImportSource react */
import { Pressable, View } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { color, radius, space } from '@swift/ui';
import { T } from '../../kit';

/**
 * "‹ Swift" — the way back from a partner sign-up (List your business, the
 * store waiting for approval, the rider/driver application) to ordering in
 * Swift. It sits where a person looks for "back": the top-left of the header.
 * Presentational only; `onPress` is the sign-up's `leave` (backToSwift.tsx),
 * which Android's back and the iOS edge swipe run too.
 */
export function BackToSwiftButton({ onPress, busy = false }: { onPress: () => void; busy?: boolean }) {
  return (
    <Pressable
      testID="partner-back-to-swift"
      accessibilityRole="button"
      accessibilityLabel="Back to Swift"
      accessibilityHint="Goes back to ordering in Swift. Your application and documents are kept."
      accessibilityState={{ disabled: busy, busy }}
      disabled={busy}
      onPress={onPress}
      hitSlop={8}
      style={{ alignSelf: 'flex-start' }}
    >
      {({ pressed }) => (
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: space.xs,
            minHeight: 44,
            paddingLeft: space.sm,
            paddingRight: space.lg,
            borderRadius: radius.full,
            borderWidth: 1,
            borderColor: color.border.subtle,
            backgroundColor: color.surface.base,
            opacity: pressed || busy ? 0.6 : 1,
          }}
        >
          <Feather name="chevron-left" size={20} color={color.text.primary} />
          <T variant="label" weight="semibold">
            Swift
          </T>
        </View>
      )}
    </Pressable>
  );
}
