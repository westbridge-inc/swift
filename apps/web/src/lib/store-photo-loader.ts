'use client';

import type { ImageLoaderProps } from 'next/image';

// A client reference can be passed to next/image by server-rendered pages too.
// Quality is fixed to 75 by the route, matching the previous WebP optimiser.
export default function storePhotoLoader({ src, width }: ImageLoaderProps): string {
  return `${src}?w=${width}`;
}
