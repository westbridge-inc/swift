/** @jsxImportSource react */
import { useState } from 'react';
import { View, type ViewStyle } from 'react-native';
import { Image } from 'expo-image';
import { color, radius, space } from '@swift/ui';
import { SectionHeader } from '../kit';
import { LIST_PHOTO_WIDTH, categoryPhoto } from '../lib/images';

/**
 * [IMAGES-E2E PR5 · COORD GO 21 Oct, owner rule "business pictures must reach customers"]
 * A menu section's header on the store page: the section's own photo above its name.
 * Only a photo Swift keeps is drawn (categoryPhoto: never an outside host), asked for at a
 * list width from the photo ladder (the strip is at most a phone screen wide). No photo, or
 * one that fails to load, is today's text header exactly: no broken tile, no empty box.
 */
export function SectionPhotoHeader({ title, imageUrl, style }: { title: string; imageUrl?: string | null; style?: ViewStyle }) {
  const [failed, setFailed] = useState(false);
  const uri = failed ? null : categoryPhoto({ name: title, imageUrl }, LIST_PHOTO_WIDTH);
  if (!uri) return <SectionHeader title={title} style={style} />;
  return (
    <View style={style}>
      <View style={{ height: 120, borderRadius: radius.lg, overflow: 'hidden', backgroundColor: color.surface.subtle, marginBottom: space.md }}>
        <Image
          source={{ uri }}
          style={{ width: '100%', height: '100%' }}
          contentFit="cover"
          transition={150}
          accessible={false}
          onError={() => setFailed(true)}
        />
      </View>
      <SectionHeader title={title} />
    </View>
  );
}
