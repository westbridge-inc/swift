import { Image as ExpoImage, type ImageProps } from 'expo-image';

// Neutral light-grey blurhash so images blur-up instead of popping in.
const NEUTRAL_BLURHASH = 'L9P?:hxu00WB~qof9Fj[00WB~qof';

/**
 * Cached, blur-up image (expo-image) — use for ALL remote images. Memory+disk
 * cache avoids re-decoding on scroll (the main source of list jank). Size it
 * via `style`; layout around it with the parent View's className.
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
