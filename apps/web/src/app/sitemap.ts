import type { MetadataRoute } from 'next';
import { SITE_ORIGIN } from '@/site.config';

/**
 * [SITE-1.1 Part 5] Only the public company pages. Deliberately hand-listed
 * rather than derived from the route tree: a generated sitemap would sweep in
 * tokenised and signed-in routes the moment someone adds one, and a sitemap
 * that advertises a private URL is worse than no sitemap.
 *
 * Store pages are excluded on purpose — they are generated from live vendor
 * data and belong in a separate feed once the catalogue is stable.
 */
const PAGES = [
  { path: '/', priority: 1.0, changeFrequency: 'weekly' as const },
  { path: '/how-it-works', priority: 0.8, changeFrequency: 'monthly' as const },
  { path: '/vendors', priority: 0.9, changeFrequency: 'monthly' as const },
  { path: '/drivers', priority: 0.9, changeFrequency: 'monthly' as const },
  { path: '/pricing', priority: 0.8, changeFrequency: 'monthly' as const },
  { path: '/faq', priority: 0.7, changeFrequency: 'monthly' as const },
  { path: '/about', priority: 0.7, changeFrequency: 'yearly' as const },
  { path: '/contact', priority: 0.7, changeFrequency: 'yearly' as const },
  { path: '/account/delete', priority: 0.5, changeFrequency: 'yearly' as const },
  { path: '/legal/privacy', priority: 0.5, changeFrequency: 'yearly' as const },
  { path: '/legal/terms', priority: 0.5, changeFrequency: 'yearly' as const },
];

export default function sitemap(): MetadataRoute.Sitemap {
  const lastModified = new Date();
  return PAGES.map(({ path, priority, changeFrequency }) => ({
    url: `${SITE_ORIGIN}${path}`,
    lastModified,
    changeFrequency,
    priority,
  }));
}
