import { View } from 'react-native';
import { color } from '@swift/ui';
import { T } from './text';
import { Image } from './image';

/**
 * Avatar — photo when there is one, otherwise initials on the soft brand
 * tint. Initials use the display face: a person's mark, not body copy.
 *
 * [DRIFT-09] Kit port of components/ui/avatar, same API. (The TrustHalo ring
 * from the design pass composes AROUND this at the screen-rebuild wave —
 * capped 84dp per the founder note; this stays the bare mark.)
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
      accessibilityLabel={name ? `${name}'s avatar` : 'Avatar'}
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: color.brand[50],
      }}
    >
      {/* variant "title" carries the display face; the size override scales
          the mark with the avatar (line-height pinned so it centers). */}
      <T
        variant="title"
        weight="bold"
        style={{ color: color.brand[700], fontSize: Math.round(size * 0.36), lineHeight: Math.round(size * 0.44) }}
      >
        {initials}
      </T>
    </View>
  );
}
