import { Image as ExpoImage, type ImageProps } from 'expo-image';
import { useReducedMotion } from 'react-native-reanimated';

// Neutral light-grey blurhash so images blur-up instead of popping in.
// (Interim: the image pipeline [S8] will hand every upload a REAL per-image
// blurhash; this constant then only covers legacy rows with none.)
const NEUTRAL_BLURHASH = 'L9P?:hxu00WB~qof9Fj[00WB~qof';

/**
 * Disk-backed, downscaled image. List windows bound mounted decoded images;
 * disk caching avoids keeping a second decoded catalogue in JS/native memory.
 *
 * [DRIFT-09] Kit port of components/ui/image. Deliberately NOT in the kit
 * barrel: `Image` as a barrel export shadows react-native's in editors and
 * invites the wrong autocomplete — import it explicitly from './image'.
 */
export function Image({ transition = 220, placeholder, contentFit = 'cover', ...props }: ImageProps) {
  const reducedMotion = useReducedMotion();
  return (
    <ExpoImage
      transition={reducedMotion ? 0 : transition}
      contentFit={contentFit}
      cachePolicy="disk"
      allowDownscaling
      enforceEarlyResizing
      placeholder={placeholder ?? { blurhash: NEUTRAL_BLURHASH }}
      {...props}
    />
  );
}
