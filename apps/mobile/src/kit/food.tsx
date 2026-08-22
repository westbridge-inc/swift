/** @jsxImportSource react */
import React from 'react';
import { Pressable, View, type ViewStyle } from 'react-native';
import { Image } from 'expo-image';
import { Feather } from '@expo/vector-icons';
import { color, radius, space, withAlpha } from '@swift/ui';
import { DARK_BLURHASH } from '../lib/images';
import { Card } from './card';
import { Pictogram, type PictogramName } from './pictograms';
import { Scrim } from '../components/ui/scrim';
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
  variant = 'photo',
  pictogram = 'orders',
  onPress,
}: {
  title: string;
  sub: string;
  cta: string;
  image?: string;
  /** 'tint' = on-language house promo: brand-50 card led by our own
   *  pictogram, no stock photography [design-100x critique gate — the photo
   *  right-slot was the most templated element on Home]. */
  variant?: 'photo' | 'tint';
  pictogram?: PictogramName;
  onPress?: () => void;
}) {
  if (variant === 'tint') {
    return (
      <Card pad={false} style={{ flexDirection: 'row', overflow: 'hidden', backgroundColor: color.brand[50] }}>
        <View style={{ flex: 1, padding: space.xl, gap: space.xs }}>
          <T variant="title">{title}</T>
          <T variant="label" tone="muted">
            {sub}
          </T>
          <PillButton label={cta} variant="dark" size="sm" onPress={onPress} style={{ alignSelf: 'flex-start', marginTop: space.md }} />
        </View>
        <View style={{ width: 108, alignItems: 'center', justifyContent: 'center' }}>
          <View style={{ width: 72, height: 72, borderRadius: radius.lg, backgroundColor: color.brand[100], alignItems: 'center', justifyContent: 'center' }}>
            <Pictogram name={pictogram} size={40} color={color.brand[600]} />
          </View>
        </View>
      </Card>
    );
  }
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

/**
 * The editorial merchant card [F-263] — the hero of a discovery rail.
 *
 * Featured merchants and popular dishes were rendering through the SAME
 * 44%-wide FoodCard, so a whole restaurant carried exactly the visual weight of
 * one plate of food and the rail had no hierarchy to read. This is the card
 * that was here before the design drifted clean: a wide 16:9 photograph, the
 * name set in the display face ON the image over a real scrim, rating and ETA
 * as pills on the photo rather than as a grey line beneath it.
 *
 * The standing lever on this product is GO RICHER, NOT CLEANER — clean-minimal
 * is precisely what made it read as basic. Photography is the colour here; the
 * palette stays restrained underneath it.
 */
export function MerchantCard({
  image,
  name,
  meta,
  rating,
  ratingBucket,
  topRated,
  favorite,
  onToggleFavorite,
  onPress,
  width,
}: {
  image: string;
  name: string;
  meta?: string;
  rating?: number | null;
  ratingBucket?: string;
  topRated?: boolean;
  favorite?: boolean;
  onToggleFavorite?: () => void;
  onPress?: () => void;
  width: number;
}) {
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={meta ? `${name}. ${meta}` : name}>
      {({ pressed }) => (
        <Card pad={false} style={{ width, opacity: pressed ? 0.85 : 1, overflow: 'hidden' }}>
          <View>
            <Image
              source={{ uri: image }}
              placeholder={{ blurhash: DARK_BLURHASH }}
              transition={150}
              style={{ width: '100%', aspectRatio: 16 / 9 }}
              contentFit="cover"
            />
            {/* A real gradient, not a flat overlay — a hard band across a photo
                is the thing that reads as cheap. */}
            <Scrim height={110} />
            {onToggleFavorite ? (
              <View style={{ position: 'absolute', top: space.md, right: space.md }}>
                <HeartBadge active={!!favorite} onPress={onToggleFavorite} />
              </View>
            ) : null}
            <View style={{ position: 'absolute', left: space.lg, right: space.lg, bottom: space.md, gap: 4 }}>
              <T variant="title" tone="onBrand" numberOfLines={1}>
                {name}
              </T>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
                {rating !== undefined ? (
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 3, backgroundColor: withAlpha(color.white, 0.92), paddingHorizontal: 7, paddingVertical: 2, borderRadius: radius.full }}>
                    <Feather name="star" size={11} color={color.star} />
                    <T variant="micro" weight="bold">
                      {rating == null ? (topRated ? 'Top rated' : (ratingBucket ?? 'New')) : rating.toFixed(1)}
                    </T>
                  </View>
                ) : null}
                {meta ? (
                  <View style={{ backgroundColor: withAlpha(color.white, 0.92), paddingHorizontal: 7, paddingVertical: 2, borderRadius: radius.full }}>
                    <T variant="micro" weight="semibold">{meta}</T>
                  </View>
                ) : null}
              </View>
            </View>
          </View>
        </Card>
      )}
    </Pressable>
  );
}
