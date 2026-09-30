/** @jsxImportSource react */
import React from 'react';
import { Pressable, View, type ViewStyle } from 'react-native';
import { Image } from 'expo-image';
import { Feather } from '@expo/vector-icons';
import { color, radius, space, withAlpha } from '@swift/ui';
import { DARK_BLURHASH } from '../lib/images';
import { Card } from './card';
import { Photo, PhotoPlaceholder } from './photo-placeholder';
import { Pictogram, type PictogramName } from './pictograms';
// [B6] The kit no longer reaches into the legacy folder — Scrim is a kit
// primitive now (DRIFT-09 port), which was the last contamination here.
import { Scrim } from './scrim';
import { HeartBadge, Stars } from './controls';
import { PillButton } from './button';
import { T } from './text';

/** The separator between meta segments. Only ever drawn BETWEEN two of them —
 *  never before the first, which is how "· Mauby's Snackette" happened. */
function MetaDot() {
  return <View style={{ width: 3, height: 3, borderRadius: 2, backgroundColor: color.text.muted }} />;
}

/**
 * NULL AND UNDEFINED MEAN DIFFERENT THINGS HERE, and conflating them printed
 * two separate lies.
 *
 *   number/string → a real rating: stars and the value.
 *   null          → "New". An EXPLICIT claim that this seller has no rating yet.
 *   undefined     → no rating claim at all. The caller does not know.
 *
 * The old guard was `rating == null`, which is true for BOTH — so a surface
 * that simply had no rating to give was made to announce "New" about a
 * long-established store. And the callers that knew this went the other way
 * and passed nothing, which the FoodCard then read as "no meta at all" and
 * dropped the store name entirely (the Popular rail on Home: the API sends
 * `vendorName`, and no card ever showed it).
 *
 * Segments compose, and the dot is drawn between them rather than in front of
 * each. `extra` alone renders as "Mauby's Snackette", not "· Mauby's Snackette".
 * A blank `extra` is not a segment at all: "New" plus a whitespace string used
 * to draw a dot beside nothing.
 *
 * The line is ONE line [Q3]. `extra` is the free text (a store name, an ETA, a
 * distance) and the only segment that can grow without bound, so it is the one
 * that gives way: it shrinks into whatever width the row is given and ends in
 * an ellipsis. It never pushes the line out of its card.
 */
export function RatingMeta({
  rating,
  bucket,
  topRated,
  extra,
}: {
  rating?: number | string | null;
  bucket?: string;
  topRated?: boolean;
  extra?: string;
}) {
  const segments: React.ReactNode[] = [];

  if (rating === null) {
    segments.push(
      <T key="new" variant="caption" tone="muted" weight="semibold">
        New
      </T>,
    );
  } else if (rating !== undefined) {
    segments.push(
      <React.Fragment key="rating">
        <Stars value={Number(rating) || 0} size={13} />
        <T variant="caption" tone="muted">
          {typeof rating === 'number' ? rating.toFixed(1) : rating}
          {bucket ? ` ${bucket}` : ''}
        </T>
      </React.Fragment>,
    );
  }

  if (topRated) {
    segments.push(
      <T key="top" variant="caption" tone="brand" weight="semibold">
        Top rated
      </T>,
    );
  }

  const extraText = extra?.trim();
  if (extraText) {
    segments.push(
      <T key="extra" variant="caption" tone="muted" numberOfLines={1} ellipsizeMode="tail" style={{ flexShrink: 1 }}>
        {extraText}
      </T>,
    );
  }

  if (segments.length === 0) return null;

  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flexShrink: 1 }}>
      {segments.map((seg, i) => (
        <React.Fragment key={i}>
          {i > 0 ? <MetaDot /> : null}
          {seg}
        </React.Fragment>
      ))}
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
  /** null ⇒ this thing genuinely has no photo; draw the honest placeholder
   *  rather than a stranger's dinner [F-264]. */
  image: string | null;
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
  // NO CARD CHASSIS [100x pass §5]: "Cards lose their gray borders —
  // photography sits on open paper, Uber-style."
  // The white card used to draw a lit box around every dish, so a shelf of food
  // read as a shelf of BOXES — the chrome competed with the only thing worth
  // looking at. Now the photograph carries its own corner radius and the name
  // and price sit on the page ground beneath it.
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={name}>
      {({ pressed }) => (
      <View style={{ width, opacity: pressed ? 0.85 : 1 }}>
        <View style={{ borderRadius: radius.lg, overflow: 'hidden' }}>
          {image ? (
            <Image
              source={{ uri: image }}
              placeholder={{ blurhash: DARK_BLURHASH }}
              transition={150}
              style={{ width: '100%', aspectRatio: 1 }}
              contentFit="cover"
            />
          ) : (
            <PhotoPlaceholder label={name} style={{ width: '100%', aspectRatio: 1 }} />
          )}
          {onToggleFavorite ? (
            <View style={{ position: 'absolute', top: space.md, right: space.md }}>
              <HeartBadge active={!!favorite} onPress={onToggleFavorite} />
            </View>
          ) : null}
        </View>
        {/* ONE FACT PER LINE, ALL INSIDE THE CARD [Q3]. The price and the meta
            used to share one row with `space-between` and nothing bounding
            either. On a 44%-wide rail card "$1,500" plus "TEST-Kitchen-One ·
            41 min" is wider than the card, and space-between has no space to
            hand out once the content overflows — so the price ran straight
            into the store name ("$1,500TEST-Kitchen-One") and the line ran on
            under the next card, which clipped "41 min" to "41 mi". Now the
            price has its own line and the meta has its own, each one line,
            the meta ending in an ellipsis; and this block clips to the card,
            so no text can paint into a neighbour. */}
        <View style={{ paddingTop: space.sm, gap: 4, overflow: 'hidden' }}>
          <T variant="label" weight="semibold" numberOfLines={1}>
            {name}
          </T>
          {priceLabel ? (
            // MONEY IN INK [100x pass §5]: "Prices were brand-red everywhere
            // — red stops meaning 'act' when it also means '$2,500'. Money is
            // now ink, tabular Bricolage; red is reserved for the rail, the
            // flagship tile, and CTAs." The numM variant is already the
            // tabular face; only the colour changes.
            <T variant="numM" numberOfLines={1}>
              {priceLabel}
            </T>
          ) : null}
          {/* RatingMeta now returns null when it has nothing to say, so this
              no longer needs to guess. The old guard dropped the WHOLE line
              whenever rating was absent — which is why the Popular rail never
              showed a store name the API had been sending all along. */}
          <RatingMeta rating={rating} bucket={ratingBucket} topRated={topRated} extra={meta} />
        </View>
      </View>
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
  /** null ⇒ no real photo; the placeholder names the merchant [F-264]. */
  image: string | null;
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
        {image ? (
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
        ) : (
          <PhotoPlaceholder
            glyph="shops"
            style={{
              width: wide ? 96 : 84,
              height: wide ? 60 : 84,
              borderRadius: radius.md,
              opacity: closed ? 0.45 : 1,
            }}
          />
        )}
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
    // [F-263 / founder 08-22] This was a washed brand-50 card with a BLACK
    // pill — the palest, most anaemic block on the screen carrying the
    // BIGGEST claim in the business ("0% fees" IS the model). A statement
    // deserves the house's full voice: deep maroon ground, white display
    // type, the pictogram as a watermark, a white pill. Rich, not louder —
    // the one saturated panel between two photography bands.
    return (
      <Card pad={false} style={{ overflow: 'hidden', backgroundColor: color.brand[600] }}>
        <View style={{ position: 'absolute', right: -14, bottom: -18, opacity: 0.14 }}>
          <Pictogram name={pictogram} size={148} color={color.white} />
        </View>
        <View style={{ padding: space.xl, gap: space.xs, paddingRight: 96 }}>
          <T variant="title" tone="onBrand">{title}</T>
          <T variant="label" tone="onBrand" style={{ opacity: 0.85 }}>
            {sub}
          </T>
          <Pressable
            onPress={onPress}
            accessibilityRole="button"
            accessibilityLabel={cta}
            style={({ pressed }) => ({
              alignSelf: 'flex-start', marginTop: space.md,
              backgroundColor: color.white, opacity: pressed ? 0.85 : 1,
              paddingHorizontal: space.xl, paddingVertical: 10, borderRadius: radius.full,
            })}
          >
            <T variant="label" weight="semibold" tone="brand">{cta}</T>
          </Pressable>
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
  /** null ⇒ no real storefront photo; never invent one [F-264]. */
  image: string | null;
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
            {image ? (
              <Image
                source={{ uri: image }}
                placeholder={{ blurhash: DARK_BLURHASH }}
                transition={150}
                style={{ width: '100%', aspectRatio: 16 / 9 }}
                contentFit="cover"
              />
            ) : (
              <PhotoPlaceholder glyph="shops" style={{ width: '100%', aspectRatio: 16 / 9 }} />
            )}
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

// The tile's footprint on Home's category rail — carried over unchanged.
const CATEGORY_TILE_W = 132;
const CATEGORY_TILE_H = 84;

/**
 * A menu category as a photograph — the tile on Home's "Find by category" rail.
 *
 * [Founder 08-22] Bare outlined text pills were the last clean-minimal islands
 * on Home. Categories are FOOD: they get photography under a scrim with a white
 * label, like every other band. The picture is the merchant's own
 * (`categoryPhoto`), and when there is none `Photo` draws the honest
 * placeholder — never a stock photograph [F-264].
 *
 * EXACTLY ONE LABEL [Q3]. The name is drawn once, white on the scrim. With no
 * photo the placeholder drew it as well — a centred caps "MENU" behind the
 * tile's own "Menu", both on an 84pt tile — so every unphotographed category
 * showed two overlapping labels. The placeholder is told the name is already
 * on the photo (`showLabel={false}`) and stays a picture: ground and pictogram.
 */
export function CategoryTile({
  name,
  image,
  onPress,
}: {
  name: string;
  /** null ⇒ the category has no photo; the placeholder is drawn [F-264]. */
  image: string | null;
  onPress?: () => void;
}) {
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={name}>
      {({ pressed }) => (
        <View
          style={{
            width: CATEGORY_TILE_W,
            height: CATEGORY_TILE_H,
            borderRadius: radius.lg,
            overflow: 'hidden',
            opacity: pressed ? 0.85 : 1,
          }}
        >
          <Photo uri={image} label={name} showLabel={false} style={{ width: '100%', height: '100%' }} />
          <Scrim height={CATEGORY_TILE_H} cover />
          <View style={{ position: 'absolute', left: space.md, right: space.md, bottom: space.sm }}>
            <T variant="label" weight="semibold" tone="onBrand" numberOfLines={1}>
              {name}
            </T>
          </View>
        </View>
      )}
    </Pressable>
  );
}
