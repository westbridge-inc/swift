/** @jsxImportSource react */
import React from 'react';
import { View, Pressable, type ViewProps, type ViewStyle } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { useNavigation } from '@react-navigation/native';
import { color, space } from '@swift/ui';
import { T } from './text';

/** Full-screen scaffold on paper. `bleed` skips the top inset (masthead screens
 *  paint their own gradient under the status bar).
 *  Plain View + inset padding, NOT the native SafeAreaView: on this new-arch
 *  RN the native safe-area view mis-frames its children for hit-testing (touch
 *  boxes land ~inset higher than the visuals), swallowing taps. */
export function Screen({ children, style, bleed = false, ...rest }: ViewProps & { bleed?: boolean }) {
  const insets = useSafeAreaInsets();
  return (
    <View
      style={[
        { flex: 1, backgroundColor: color.surface.subtle, paddingTop: bleed ? 0 : insets.top },
        style as ViewStyle,
      ]}
      {...rest}
    >
      {children}
    </View>
  );
}

/** 44pt circular chip — the kit's back button / header accessory. `light` is
 *  the on-masthead variant (translucent fill, white glyph). */
export function CircleChip({
  icon,
  onPress,
  light = false,
  size = 44,
}: {
  icon: React.ComponentProps<typeof Feather>['name'];
  onPress?: () => void;
  light?: boolean;
  size?: number;
}) {
  return (
    // NB: never a function-form `style` on Pressable — the NativeWind interop
    // corrupts the touch box (it can bleed over siblings). Pressed feedback
    // lives on the inner View via the function child.
    <Pressable onPress={onPress} hitSlop={8}>
      {({ pressed }) => (
        <View
          style={{
            width: size,
            height: size,
            borderRadius: size / 2,
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: light ? 'rgba(255,255,255,0.16)' : color.surface.base,
            borderWidth: 1,
            borderColor: light ? 'rgba(255,255,255,0.55)' : color.border.subtle,
            opacity: pressed ? 0.65 : 1,
          }}
        >
          <Feather name={icon} size={20} color={light ? color.white : color.text.primary} />
        </View>
      )}
    </Pressable>
  );
}

/** Kit header row: back chip · centered title · optional right accessory. */
export function Header({
  title,
  right,
  light = false,
  onBack,
}: {
  title?: string;
  right?: React.ReactNode;
  light?: boolean;
  onBack?: () => void;
}) {
  const nav = useNavigation();
  return (
    <View
      style={{
        height: 56,
        paddingHorizontal: space.xl,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
      }}
    >
      <CircleChip icon="chevron-left" light={light} onPress={onBack ?? (() => nav.goBack())} />
      {title ? (
        <T variant="heading" tone={light ? 'onBrand' : 'ink'}>
          {title}
        </T>
      ) : (
        <View />
      )}
      {right ?? <View style={{ width: 44 }} />}
    </View>
  );
}
