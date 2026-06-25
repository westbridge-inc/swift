import { View } from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { color } from '@swift/ui';
import { Text } from './text';
import { Image } from './image';
import { Scrim } from './scrim';
import { PressableScale } from './pressable-scale';
import { elevation } from './elevation';

/**
 * Full-width feed banner — warm, rounded, red. The dynamic-feed hero card
 * (promos / value-prop messaging). Photography is optional and falls back to a
 * solid brand fill, so it never depends on an asset being present.
 */
export function PromoBanner({
  title,
  subtitle,
  cta,
  image,
  icon = 'tag-heart',
  onPress,
}: {
  title: string;
  subtitle?: string;
  cta?: string;
  image?: string;
  icon?: keyof typeof MaterialCommunityIcons.glyphMap;
  onPress?: () => void;
}) {
  return (
    <PressableScale onPress={onPress}>
      <View
        className="mx-lg overflow-hidden rounded-3xl"
        style={[{ backgroundColor: color.brand[500] }, elevation.floating]}
      >
        {image ? (
          <>
            <Image source={{ uri: image }} style={{ position: 'absolute', width: '100%', height: '100%' }} />
            <Scrim cover from="rgba(232,25,44,0.94)" to="rgba(147,15,26,0.88)" />
          </>
        ) : null}
        <View className="flex-row items-center p-lg">
          <View className="flex-1 pr-md">
            <Text className="font-display text-lg font-extrabold text-white" numberOfLines={2}>
              {title}
            </Text>
            {subtitle ? (
              <Text className="mt-1 text-[13px] leading-5 text-white" style={{ opacity: 0.92 }} numberOfLines={3}>
                {subtitle}
              </Text>
            ) : null}
            {cta ? (
              <View className="mt-md self-start rounded-full bg-white px-lg py-2">
                <Text className="text-[13px] font-bold" style={{ color: color.brand[600] }}>
                  {cta}
                </Text>
              </View>
            ) : null}
          </View>
          <View
            className="h-16 w-16 items-center justify-center rounded-full"
            style={{ backgroundColor: 'rgba(255,255,255,0.18)' }}
          >
            <MaterialCommunityIcons name={icon} size={32} color="#fff" />
          </View>
        </View>
      </View>
    </PressableScale>
  );
}
