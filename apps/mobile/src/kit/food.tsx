import React from 'react';
import { Pressable, View, type ViewStyle } from 'react-native';
import { Image } from 'expo-image';
import { Feather } from '@expo/vector-icons';
import { color, radius, space } from '@swift/ui';
import { DARK_BLURHASH } from '../lib/images';
import { Card } from './card';
import { HeartBadge, Stars } from './controls';
import { PillButton } from './button';
import { T } from './text';

/** star · value · (dot · extra) meta line under names. */
export function RatingMeta({ rating, extra }: { rating: number | string; extra?: string }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
      <Stars value={Number(rating) || 0} size={13} />
      <T variant="caption" tone="muted">
        {typeof rating === 'number' ? rating.toFixed(1) : rating}
      </T>
      {extra ? (
        <>
          <View style={{ width: 3, height: 3, borderRadius: 2, backgroundColor: color.text.muted }} />
          <T variant="caption" tone="muted">
            {extra}
          </T>
        </>
      ) : null}
    </View>
  );
}

/** Kit 2-col photo card (recommended grids) — square image, heart overlay,
 *  name + price/rating footer. */
export function FoodCard({
  image,
  name,
  priceLabel,
  rating,
  meta,
  favorite,
  onToggleFavorite,
  onPress,
  width,
}: {
  image: string;
  name: string;
  priceLabel?: string;
  rating?: number;
  meta?: string;
  favorite?: boolean;
  onToggleFavorite?: () => void;
  onPress?: () => void;
  width: number;
}) {
  return (
    <Pressable onPress={onPress} style={({ pressed }) => ({ width, opacity: pressed ? 0.85 : 1 })}>
      <Card pad={false} style={{ width }}>
        <View>
          <Image
            source={{ uri: image }}
            placeholder={{ blurhash: DARK_BLURHASH }}
            transition={150}
            style={{ width: '100%', aspectRatio: 1 }}
            contentFit="cover"
          />
          {onToggleFavorite ? (
            <View style={{ position: 'absolute', top: space.md, right: space.md }}>
              <HeartBadge active={!!favorite} onPress={onToggleFavorite} />
            </View>
          ) : null}
        </View>
        <View style={{ padding: space.md, gap: 4 }}>
          <T variant="label" weight="semibold" numberOfLines={1}>
            {name}
          </T>
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
            {priceLabel ? (
              <T variant="label" weight="bold" tone="brand">
                {priceLabel}
              </T>
            ) : (
              <View />
            )}
            {rating !== undefined ? <RatingMeta rating={rating} extra={meta} /> : null}
          </View>
        </View>
      </Card>
    </Pressable>
  );
}

/** Landscape list card (nearby / search results): thumb · name · meta · trailing. */
export function VendorRow({
  image,
  name,
  meta,
  sub,
  trailing,
  onPress,
  style,
}: {
  image: string;
  name: string;
  meta?: React.ReactNode;
  sub?: string;
  trailing?: React.ReactNode;
  onPress?: () => void;
  style?: ViewStyle;
}) {
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [{ opacity: pressed ? 0.85 : 1 }, style]}>
      <Card style={{ flexDirection: 'row', alignItems: 'center', gap: space.md, padding: space.md }}>
        <Image
          source={{ uri: image }}
          placeholder={{ blurhash: DARK_BLURHASH }}
          transition={150}
          style={{ width: 84, height: 84, borderRadius: radius.md }}
          contentFit="cover"
        />
        <View style={{ flex: 1, gap: 4 }}>
          <T variant="body" weight="semibold" numberOfLines={1}>
            {name}
          </T>
          {meta}
          {sub ? (
            <T variant="caption" tone="muted" numberOfLines={1}>
              {sub}
            </T>
          ) : null}
        </View>
        {trailing ?? <Feather name="chevron-right" size={18} color={color.text.muted} />}
      </Card>
    </Pressable>
  );
}

/** Masthead promo banner: white card, bold claim, dark pill CTA, dish photo. */
export function PromoBanner({
  title,
  sub,
  cta,
  image,
  onPress,
}: {
  title: string;
  sub: string;
  cta: string;
  image?: string;
  onPress?: () => void;
}) {
  return (
    <Card pad={false} style={{ flexDirection: 'row', overflow: 'hidden' }}>
      <View style={{ flex: 1, padding: space.xl, gap: space.xs }}>
        <T variant="title">{title}</T>
        <T variant="label" tone="muted">
          {sub}
        </T>
        <PillButton label={cta} variant="dark" size="sm" onPress={onPress} style={{ alignSelf: 'flex-start', marginTop: space.md }} />
      </View>
      {image ? (
        <Image
          source={{ uri: image }}
          placeholder={{ blurhash: DARK_BLURHASH }}
          transition={150}
          style={{ width: 130, height: '100%' }}
          contentFit="cover"
        />
      ) : null}
    </Card>
  );
}
