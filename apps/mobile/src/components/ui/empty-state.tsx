import { View } from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { color } from '@swift/ui';
import { Text, Heading } from './text';
import { Button } from './button';

/**
 * The one warm empty state — a soft icon medallion, a display heading, friendly
 * body copy, and an optional CTA. Formalises the best pattern (Home / MoverOps)
 * so bare lists (Orders, Search, Courier) read with personality, not blankness.
 */
export function EmptyState({
  icon = 'inbox-outline',
  title,
  body,
  actionLabel,
  onAction,
}: {
  icon?: keyof typeof MaterialCommunityIcons.glyphMap;
  title: string;
  body?: string;
  actionLabel?: string;
  onAction?: () => void;
}) {
  return (
    <View className="items-center px-xl py-2xl">
      <View className="mb-md h-16 w-16 items-center justify-center rounded-full bg-surface-subtle">
        <MaterialCommunityIcons name={icon} size={30} color={color.text.muted} />
      </View>
      <Heading size="lg" className="text-center">
        {title}
      </Heading>
      {body ? <Text className="mt-xs text-center text-sm text-text-secondary">{body}</Text> : null}
      {actionLabel && onAction ? <Button label={actionLabel} className="mt-lg px-2xl" onPress={onAction} /> : null}
    </View>
  );
}
