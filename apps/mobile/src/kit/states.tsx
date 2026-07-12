/** @jsxImportSource react */
import React from 'react';
import { ActivityIndicator, View, type ViewStyle } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { color, space } from '@swift/ui';
import { PillButton } from './button';
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

/** Kit-style empty state: big soft icon chip, title, body, optional action. */
export function EmptyState({
  icon = 'inbox',
  title,
  body,
  actionLabel,
  onAction,
  style,
}: {
  icon?: React.ComponentProps<typeof Feather>['name'];
  title: string;
  body?: string;
  actionLabel?: string;
  onAction?: () => void;
  style?: ViewStyle;
}) {
  return (
    <View style={[{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: space['3xl'], gap: space.md }, style]}>
      <IconChip icon={icon} size={72} />
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

/** Real error state with retry — never a silent blank screen. */
export function ErrorState({ onRetry, message, style }: { onRetry?: () => void; message?: string; style?: ViewStyle }) {
  return (
    <View style={[{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: space['3xl'], gap: space.md }, style]}>
      <IconChip icon="alert-circle" size={72} tone="error" />
      <T variant="heading" center style={{ marginTop: space.sm }}>
        Something went wrong
      </T>
      <T variant="label" tone="muted" center style={{ maxWidth: 260 }}>
        {message ?? "We couldn't load this. Check your connection and try again."}
      </T>
      {onRetry ? <PillButton label="Try Again" onPress={onRetry} size="md" style={{ marginTop: space.md }} /> : null}
    </View>
  );
}
