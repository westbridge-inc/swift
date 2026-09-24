/** @jsxImportSource react */
import React from 'react';
import { View, type ViewStyle } from 'react-native';
import { Image } from 'expo-image';
import { color, radius, space } from '@swift/ui';
import { DARK_BLURHASH } from '../lib/images';
import { T } from './text';
import { Pictogram, type PictogramName } from './pictograms';

/**
 * What a card shows when an item or a merchant genuinely has no photograph.
 *
 * The alternative it replaces was worse than a blank: `fallbackImage()` handed
 * out a RANDOM stock photo keyed off the row id, so "Mauby" — a Guyanese drink
 * — was advertised on Home with a photograph of a cheeseburger. That is not a
 * cosmetic slip on a marketplace. A customer chooses from the picture, and a
 * picture of something they are not buying is a misrepresentation of the goods.
 * Worse, it is corrosive: once ANY photo on the screen might be invented, the
 * real ones stop being evidence too.
 *
 * So: never a stranger's food. A designed tile instead — the vertical's own
 * ground colour, its pictogram, and the item's own name. That is honest, it
 * still reads as deliberate rather than broken, and it keeps the screen rich,
 * which is the standing lever here (clean-minimal is what made this app read
 * as basic — a grey box would be the wrong repair).
 *
 * It also creates the right incentive: an unphotographed item looks plainly
 * unfinished to the merchant who owns it, rather than being quietly papered
 * over with someone else's dinner.
 */
export function PhotoPlaceholder({
  label,
  glyph = 'food',
  tint,
  style,
  showLabel = true,
}: {
  /** The real name of the thing — the one honest signal available. */
  label?: string;
  glyph?: PictogramName;
  tint?: { bg: string; ink: string };
  style?: ViewStyle;
  /**
   * false when the caller already draws the name ON the photo — the white
   * scrim label on a category tile, the title on a store's cover. The
   * placeholder then stays a picture (ground and pictogram) and the name is
   * drawn once. Drawing it here as well put a centred "MENU" behind the
   * tile's own "Menu": two labels, overlapping, on an 84pt tile [Q3]. The
   * screen reader still hears `label`.
   */
  showLabel?: boolean;
}) {
  const bg = tint?.bg ?? color.brand[50];
  const ink = tint?.ink ?? color.brand[600];
  return (
    <View
      style={[
        {
          backgroundColor: bg,
          alignItems: 'center',
          justifyContent: 'center',
          gap: space.sm,
          padding: space.md,
        },
        style,
      ]}
      accessible
      accessibilityLabel={label ? `${label}. No photo yet` : 'No photo yet'}
    >
      <Pictogram name={glyph} size={30} color={ink} />
      {label && showLabel ? (
        <T variant="micro" weight="semibold" numberOfLines={2} style={{ color: ink, textAlign: 'center', opacity: 0.85 }}>
          {label}
        </T>
      ) : null}
    </View>
  );
}

/** Rounded square for row-sized slots (VendorRow, cart lines). */
export function PhotoPlaceholderTile({ size = 84, ...rest }: { size?: number } & React.ComponentProps<typeof PhotoPlaceholder>) {
  return <PhotoPlaceholder {...rest} style={{ width: size, height: size, borderRadius: radius.md }} />;
}

/**
 * A photograph, or an honest admission that there isn't one [F-264].
 *
 * The raw `<Image source={{ uri: itemImage(x) }}>` pattern is how invented
 * photos spread: the helper always returned a string, so every call site
 * silently rendered a stranger's food and no reviewer could see the lie at the
 * call site. This makes the absence explicit and impossible to ignore — the
 * `uri` is nullable, so a caller must decide what "no photo" looks like.
 */
export function Photo({
  uri,
  label,
  glyph,
  tint,
  style,
  contentFit = 'cover',
  transition = 150,
  showLabel,
}: {
  uri: string | null | undefined;
  label?: string;
  glyph?: PictogramName;
  tint?: { bg: string; ink: string };
  style?: ViewStyle;
  contentFit?: 'cover' | 'contain';
  transition?: number;
  /** Passed to the placeholder: false when the caller draws the name on top. */
  showLabel?: boolean;
}) {
  if (!uri) return <PhotoPlaceholder label={label} glyph={glyph} tint={tint} style={style} showLabel={showLabel} />;
  return (
    <Image
      source={{ uri }}
      placeholder={{ blurhash: DARK_BLURHASH }}
      transition={transition}
      style={style as never}
      contentFit={contentFit}
      accessibilityLabel={label}
    />
  );
}
