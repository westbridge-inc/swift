import React from 'react';
import { View, Pressable, type ViewProps, type ViewStyle } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { useNavigation } from '@react-navigation/native';
import { color, space } from '@swift/ui';
import { T } from './text';

/** Full-screen scaffold on paper. `bleed` skips the top inset (masthead screens
 *  paint their own gradient under the status bar). */
export function Screen({ children, style, bleed = false, ...rest }: ViewProps & { bleed?: boolean }) {
  return (
    <SafeAreaView
      edges={bleed ? [] : ['top']}
      style={[{ flex: 1, backgroundColor: color.surface.subtle }, style as ViewStyle]}
      {...rest}
    >
      {children}
    </SafeAreaView>
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
    <Pressable
      onPress={onPress}
      hitSlop={8}
      style={({ pressed }) => ({
        width: size,
        height: size,
        borderRadius: size / 2,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: light ? 'rgba(255,255,255,0.16)' : color.surface.base,
        borderWidth: 1,
        borderColor: light ? 'rgba(255,255,255,0.55)' : color.border.subtle,
        opacity: pressed ? 0.65 : 1,
      })}
    >
      <Feather name={icon} size={20} color={light ? color.white : color.text.primary} />
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
