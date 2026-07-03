import { Children, isValidElement, type ReactNode } from 'react';
import { View } from 'react-native';
import { Feather, MaterialCommunityIcons } from '@expo/vector-icons';
import { color } from '@swift/ui';
import { Text } from './text';
import { PressableScale } from './pressable-scale';
import { elevation } from './elevation';

type Glyph = keyof typeof MaterialCommunityIcons.glyphMap;

// Inset so dividers + content start after the icon column (px-md 12 + 28 + mr-md 12).
const INSET = 52;

/** Small grey section label above a settings group (iOS / Claude-settings style). */
export function SettingsSectionLabel({ children }: { children: ReactNode }) {
  return (
    <Text className="mb-sm ml-md text-xs font-semibold uppercase text-text-muted" style={{ letterSpacing: 0.6 }}>
      {children}
    </Text>
  );
}

/**
 * A rounded white card holding a set of `SettingsRow`s with hairline inset
 * dividers between them — the professional grouped-list pattern used across all
 * role account/settings screens. Sits on a `surface-subtle` background so the
 * card reads as elevated.
 */
export function SettingsGroup({ header, children }: { header?: string; children: ReactNode }) {
  const items = Children.toArray(children).filter(isValidElement);
  return (
    <View className="mb-lg">
      {header ? <SettingsSectionLabel>{header}</SettingsSectionLabel> : null}
      <View className="overflow-hidden rounded-2xl bg-surface-base" style={elevation.card}>
        {items.map((child, i) => (
          <View key={i}>
            {i > 0 ? <View style={{ height: 1, marginLeft: INSET, backgroundColor: color.border.subtle }} /> : null}
            {child}
          </View>
        ))}
      </View>
    </View>
  );
}

/** One row in a `SettingsGroup`: icon + label (+ optional sublabel / value / right). */
export function SettingsRow({
  icon,
  iconColor,
  label,
  sublabel,
  value,
  right,
  onPress,
  danger,
}: {
  icon?: Glyph;
  iconColor?: string;
  label: string;
  sublabel?: string;
  value?: string;
  right?: ReactNode;
  onPress?: () => void;
  danger?: boolean;
}) {
  const body = (
    <View className="flex-row items-center px-md" style={{ minHeight: 54, paddingVertical: 12 }}>
      {icon ? (
        <View style={{ width: 28, alignItems: 'center' }} className="mr-md">
          <MaterialCommunityIcons name={icon} size={20} color={danger ? color.brand[600] : (iconColor ?? color.text.secondary)} />
        </View>
      ) : null}
      <View className="flex-1">
        <Text
          className={danger ? 'text-base font-semibold' : 'text-base font-medium text-text-primary'}
          style={danger ? { color: color.brand[600] } : undefined}
          numberOfLines={1}
        >
          {label}
        </Text>
        {sublabel ? <Text className="mt-0.5 text-sm text-text-muted" numberOfLines={2}>{sublabel}</Text> : null}
      </View>
      {value ? <Text className="ml-sm text-sm text-text-muted" numberOfLines={1}>{value}</Text> : null}
      {right ?? (onPress && !danger ? <Feather name="chevron-right" size={20} color={color.text.muted} style={{ marginLeft: 4 }} /> : null)}
    </View>
  );
  return onPress ? <PressableScale onPress={onPress}>{body}</PressableScale> : body;
}
