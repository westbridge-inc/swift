import { View } from 'react-native';
import { withAlpha, color } from '@swift/ui';
import { Text } from './text';
import { Image } from './image';
import { Scrim } from './scrim';
import { PressableScale } from './pressable-scale';
import { elevation } from './elevation';
import { SwiftMark } from '../SwiftLogo';

/**
 * Full-width feed banner — the dynamic-feed hero. Carries the Swift **signature**:
 * a swift in flight trailing across the banner (a large faint watermark + the mark
 * as the badge), so the brand gesture is unmistakable. Photography is optional and
 * falls back to the solid brand fill.
 */
export function PromoBanner({
  title,
  subtitle,
  cta,
  image,
  onPress,
}: {
  title: string;
  subtitle?: string;
  cta?: string;
  image?: string;
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
            <Scrim cover from={withAlpha(color.brand[500], 0.8)} to={withAlpha(color.brand[600], 0.9)} />
          </>
        ) : null}
        {/* Signature — a swift in flight across the banner */}
        <View
          style={{ pointerEvents: 'none', position: 'absolute', right: -28, top: -24, opacity: 0.12, transform: [{ rotate: '-8deg' }] }}
        >
          <SwiftMark size={172} tint={color.white} accent={color.white} />
        </View>
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
            className="h-16 w-16 items-center justify-center rounded-2xl"
            style={{ backgroundColor: color.surface.onBrand }}
          >
            <SwiftMark size={34} tint={color.white} accent={withAlpha(color.white, 0.85)} />
          </View>
        </View>
      </View>
    </PressableScale>
  );
}
