import { View, Pressable } from 'react-native';
import { color } from '@swift/ui';
import { Text } from './text';

/**
 * Kit "Title Section": section title with an optional trailing action
 * ("See All"). One shared anatomy so every list section reads the same.
 */
export function SectionHeader({
  title,
  action,
  onAction,
  className,
}: {
  title: string;
  action?: string;
  onAction?: () => void;
  className?: string;
}) {
  return (
    <View className={`mb-sm mt-xl flex-row items-center justify-between px-lg ${className ?? ''}`}>
      <Text className="font-semibold text-text-primary" style={{ fontSize: 16 }}>{title}</Text>
      {action ? (
        <Pressable onPress={onAction} hitSlop={8}>
          <Text className="font-medium" style={{ fontSize: 14, color: color.text.muted }}>{action}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}
