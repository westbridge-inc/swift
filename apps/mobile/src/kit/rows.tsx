/** @jsxImportSource react */
import React from 'react';
import { Pressable, View, type ViewStyle } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { color, radius, space } from '@swift/ui';
import { LinkText } from './button';
import { T } from './text';

/** Section title + optional “See all”.
 *  `size="lg"` renders the design-100× `title` step (Bricolage) — flows opt in
 *  as they are elevated; when the register empties, lg becomes the default. */
export function SectionHeader({
  title,
  onSeeAll,
  style,
  size = 'md',
}: {
  title: string;
  onSeeAll?: () => void;
  style?: ViewStyle;
  size?: 'md' | 'lg';
}) {
  return (
    <View
      style={[
        { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between' },
        style,
      ]}
    >
      <T variant={size === 'lg' ? 'title' : 'heading'}>{title}</T>
      {onSeeAll ? <LinkText label="See all" onPress={onSeeAll} tone="muted" /> : null}
    </View>
  );
}

/** Brand-soft rounded-square icon chip (settings / profile rows). */
export function IconChip({
  icon,
  size = 44,
  tone = 'brand',
}: {
  icon: React.ComponentProps<typeof Feather>['name'];
  size?: number;
  tone?: 'brand' | 'error';
}) {
  const fg = tone === 'error' ? color.error : color.brand[600];
  const bg = tone === 'error' ? color.soft.danger : color.brand[50];
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: radius.md,
        backgroundColor: bg,
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <Feather name={icon} size={size * 0.45} color={fg} />
    </View>
  );
}

/** Kit settings row: icon chip · label (+optional sub) · right slot or chevron. */
export function SettingsRow({
  icon,
  label,
  sub,
  right,
  onPress,
  tone = 'brand',
}: {
  icon: React.ComponentProps<typeof Feather>['name'];
  label: string;
  sub?: string;
  right?: React.ReactNode;
  onPress?: () => void;
  tone?: 'brand' | 'error';
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={!onPress}
      accessibilityRole={onPress ? 'button' : undefined}
      accessibilityLabel={sub ? `${label}. ${sub}` : label}
    >
      {({ pressed }) => (
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: space.lg,
          paddingVertical: space.md,
          opacity: pressed ? 0.65 : 1,
        }}
      >
        <IconChip icon={icon} tone={tone} />
        <View style={{ flex: 1 }}>
          <T variant="body" weight="medium" tone={tone === 'error' ? 'error' : 'ink'}>
            {label}
          </T>
          {sub ? (
            <T variant="caption" tone="muted" style={{ marginTop: 2 }}>
              {sub}
            </T>
          ) : null}
        </View>
        {right ?? (onPress ? <Feather name="chevron-right" size={20} color={color.text.muted} /> : null)}
      </View>
      )}
    </Pressable>
  );
}

/** Summary line (order summary / receipts) — receipt-grade (design-100×):
 *  quiet label left; every value in tabular `numM`; the total (`strong`) in
 *  `numL`. Money reads like it came off a till, everywhere. */
export function InfoRow({
  label,
  value,
  strong = false,
}: {
  label: string;
  value: string;
  strong?: boolean;
}) {
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingVertical: 6,
      }}
    >
      <T variant={strong ? 'body' : 'label'} tone={strong ? 'ink' : 'muted'} weight={strong ? 'semibold' : 'regular'}>
        {label}
      </T>
      <T variant={strong ? 'numL' : 'numM'}>{value}</T>
    </View>
  );
}
