/** @jsxImportSource react */
import React, { useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, View, type LayoutChangeEvent, type StyleProp, type ViewStyle } from 'react-native';
import Animated, { Easing, useAnimatedStyle, useSharedValue, withRepeat, withTiming } from 'react-native-reanimated';
import { Feather } from '@expo/vector-icons';
import { color, radius, space, withAlpha } from '@swift/ui';
import { PillButton } from './button';
import { Pictogram, type PictogramName } from './pictograms';
import { IconChip } from './rows';
import { T } from './text';

/** Centered brand spinner for query-loading screens/sections. */
export function LoadingBlock({ style }: { style?: ViewStyle }) {
  return (
    <View style={[{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: space['3xl'] }, style]}>
      <ActivityIndicator size="large" color={color.brand[500]} />
    </View>
  );
}

/** Kit-style empty state: pictogram (9.6) or soft icon chip, title, body,
 *  exactly one action. Empty states are invitations, never sad faces. */
export function EmptyState({
  icon = 'inbox',
  picto,
  title,
  body,
  actionLabel,
  onAction,
  style,
}: {
  icon?: React.ComponentProps<typeof Feather>['name'];
  picto?: PictogramName;
  title: string;
  body?: string;
  actionLabel?: string;
  onAction?: () => void;
  style?: ViewStyle;
}) {
  return (
    <View style={[{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: space['3xl'], gap: space.md }, style]}>
      {picto ? (
        <View
          style={{
            width: 72,
            height: 72,
            borderRadius: radius.lg,
            backgroundColor: color.brand[50],
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Pictogram name={picto} size={36} color={color.brand[600]} />
        </View>
      ) : (
        <IconChip icon={icon} size={72} />
      )}
      <T variant="heading" center style={{ marginTop: space.sm }}>
        {title}
      </T>
      {body ? (
        <T variant="label" tone="muted" center style={{ maxWidth: 260 }}>
          {body}
        </T>
      ) : null}
      {actionLabel && onAction ? (
        <PillButton label={actionLabel} onPress={onAction} size="md" style={{ marginTop: space.md, alignSelf: 'stretch' }} />
      ) : null}
    </View>
  );
}

/** Brand spinner — the bare wait for inline moments; a LOADING SCREEN uses
 *  Skeleton shaped like the final layout instead (no blank flashes).
 *  [B6] Kit port of components/ui Spinner. */
export function Spinner({ size = 'small' }: { size?: 'small' | 'large' }) {
  return <ActivityIndicator size={size} color={color.brand[500]} />;
}

/**
 * Loading placeholder with a real **shimmer sweep** — a soft highlight
 * travels across the block. Size it with `style` (height/width/radius);
 * a skeleton is shaped like the layout it stands in for, so the size IS
 * the point. [B6] Kit port of components/ui Skeleton, className → style.
 */
export function Skeleton({ style }: { style?: StyleProp<ViewStyle> }) {
  const [w, setW] = useState(0);
  const x = useSharedValue(0);

  useEffect(() => {
    if (w === 0) return;
    x.value = 0;
    x.value = withRepeat(withTiming(1, { duration: 1200, easing: Easing.inOut(Easing.ease) }), -1, false);
  }, [w, x]);

  const sweep = useAnimatedStyle(() => ({ transform: [{ translateX: -w + x.value * 2 * w }] }));
  const onLayout = (e: LayoutChangeEvent) => setW(e.nativeEvent.layout.width);

  return (
    <View onLayout={onLayout} style={[{ backgroundColor: color.surface.subtle, overflow: 'hidden', borderRadius: radius.md }, style]}>
      {w > 0 ? (
        <Animated.View style={[StyleSheet.absoluteFill, sweep]}>
          <View style={{ height: '100%', width: w * 0.5, backgroundColor: withAlpha(color.white, 0.6) }} />
        </Animated.View>
      ) : null}
    </View>
  );
}

/** Real error state with retry — never a silent blank screen. */
export function ErrorState({ onRetry, message, style }: { onRetry?: () => void; message?: string; style?: ViewStyle }) {
  return (
    <View style={[{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: space['3xl'], gap: space.md }, style]}>
      <IconChip icon="alert-circle" size={72} tone="error" />
      <T variant="heading" center style={{ marginTop: space.sm }}>
        We couldn't load this
      </T>
      <T variant="label" tone="muted" center style={{ maxWidth: 260 }}>
        {message ?? 'Check your connection and try again.'}
      </T>
      {onRetry ? <PillButton label="Try again" onPress={onRetry} size="md" style={{ marginTop: space.md }} /> : null}
    </View>
  );
}
