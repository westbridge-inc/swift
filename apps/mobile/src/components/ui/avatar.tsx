import { View } from 'react-native';
import { color } from '@swift/ui';
import { Text } from './text';
import { Image } from './image';

/**
 * Avatar — photo when there is one, otherwise initials on the soft brand
 * tint. Initials use the display face: a person's mark, not body copy.
 */
export function Avatar({ name, uri, size = 44 }: { name?: string; uri?: string | null; size?: number }) {
  if (uri) {
    return <Image source={{ uri }} style={{ width: size, height: size, borderRadius: size / 2 }} />;
  }
  const initials = (name ?? '')
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? '')
    .join('') || '•';
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: color.brand[50],
      }}
    >
      <Text className="font-display font-bold" style={{ color: color.brand[700], fontSize: Math.round(size * 0.36) }}>
        {initials}
      </Text>
    </View>
  );
}
