/** @jsxImportSource react */
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

/** THE star line (Movement R, R8) — every store-card context renders this one
 *  component. `rating` null = under min-display → the quiet "New" word;
 *  otherwise star · Bayesian value · count bucket, then Top rated as
 *  typographic state (no badge soup), then (dot · extra). */
export function RatingMeta({
  rating,
  bucket,
  topRated,
  extra,
}: {
  rating: number | string | null;
  bucket?: string;
  topRated?: boolean;
  extra?: string;
}) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
      {rating == null ? (
        <T variant="caption" tone="muted" weight="semibold">
          New
        </T>
      ) : (
        <>
          <Stars value={Number(rating) || 0} size={13} />
          <T variant="caption" tone="muted">
            {typeof rating === 'number' ? rating.toFixed(1) : rating}
            {bucket ? ` ${bucket}` : ''}
          </T>
        </>
      )}
      {topRated ? (
        <>
          <View style={{ width: 3, height: 3, borderRadius: 2, backgroundColor: color.text.muted }} />
          <T variant="caption" tone="brand" weight="semibold">
            Top rated
          </T>
        </>
      ) : null}
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
  ratingBucket,
  topRated,
  meta,
  favorite,
  onToggleFavorite,
  onPress,
  width,
}: {
  image: string;
  name: string;
  priceLabel?: string;
  /** number = show stars · null = the "New" face · undefined = no star line. */
  rating?: number | null;
  ratingBucket?: string;
  topRated?: boolean;
  meta?: string;
  favorite?: boolean;
  onToggleFavorite?: () => void;
  onPress?: () => void;
  width: number;
}) {
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={name}>
      {({ pressed }) => (
      <Card pad={false} style={{ width, opacity: pressed ? 0.85 : 1 }}>
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
              <T variant="numM" tone="brand">
                {priceLabel}
              </T>
            ) : (
              <View />
            )}
            {rating !== undefined ? <RatingMeta rating={rating} bucket={ratingBucket} topRated={topRated} extra={meta} /> : null}
          </View>
        </View>
      </Card>
      )}
    </Pressable>
  );
}

/** Landscape list card (nearby / search results): thumb · name · meta · trailing.
 *  `wide` = the 16:10 vendor-imagery ratio (9.6 law: vendors 16:10, products 1:1).
 *  `closed` = the sleep treatment — availability as typographic state: the thumb
 *  dims, the name softens, one micro line speaks. Open rows say nothing
 *  (silence means open — no badge soup, ever). */
export function VendorRow({
  image,
  name,
  meta,
  sub,
  trailing,
  onPress,
  style,
  wide = false,
  closed = false,
}: {
  image: string;
  name: string;
  meta?: React.ReactNode;
  sub?: string;
  trailing?: React.ReactNode;
  onPress?: () => void;
  style?: ViewStyle;
  wide?: boolean;
  closed?: boolean;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={closed ? `${name}. Closed right now` : sub ? `${name}. ${sub}` : name}
    >
      {({ pressed }) => (
      <Card style={[{ flexDirection: 'row', alignItems: 'center', gap: space.md, padding: space.md, opacity: pressed ? 0.85 : 1 }, style]}>
        <Image
          source={{ uri: image }}
          placeholder={{ blurhash: DARK_BLURHASH }}
          transition={150}
          style={{
            width: wide ? 96 : 84,
            height: wide ? 60 : 84,
            borderRadius: radius.md,
            opacity: closed ? 0.45 : 1,
          }}
          contentFit="cover"
        />
        <View style={{ flex: 1, gap: 4 }}>
          <T variant="body" weight="semibold" tone={closed ? 'muted' : 'ink'} numberOfLines={1}>
            {name}
          </T>
          {meta}
          {closed ? (
            <T variant="micro" tone="faint">
              Closed right now
            </T>
          ) : sub ? (
            <T variant="caption" tone="muted" numberOfLines={1}>
              {sub}
            </T>
          ) : null}
        </View>
        {trailing ?? <Feather name="chevron-right" size={18} color={color.text.muted} />}
      </Card>
      )}
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
