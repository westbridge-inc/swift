import { Image as ExpoImage, type ImageProps } from 'expo-image';

// Neutral light-grey blurhash so images blur-up instead of popping in.
// (Interim: the image pipeline [S8] will hand every upload a REAL per-image
// blurhash; this constant then only covers legacy rows with none.)
const NEUTRAL_BLURHASH = 'L9P?:hxu00WB~qof9Fj[00WB~qof';

/**
 * Cached, blur-up image (expo-image) — use for ALL remote images. Memory+disk
 * cache avoids re-decoding on scroll (the main source of list jank). Size it
 * via `style`.
 *
 * [DRIFT-09] Kit port of components/ui/image. Deliberately NOT in the kit
 * barrel: `Image` as a barrel export shadows react-native's in editors and
 * invites the wrong autocomplete — import it explicitly from './image'.
 */
export function Image({ transition = 220, placeholder, contentFit = 'cover', ...props }: ImageProps) {
  return (
    <ExpoImage
      transition={transition}
      contentFit={contentFit}
      cachePolicy="memory-disk"
      placeholder={placeholder ?? { blurhash: NEUTRAL_BLURHASH }}
      {...props}
    />
  );
}
