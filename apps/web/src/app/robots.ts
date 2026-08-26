import type { MetadataRoute } from 'next';
import { SITE_ORIGIN } from '@/site.config';

/**
 * [SITE-1.1 Part 5 / AC-11] Marketing and legal routes are indexable; every
 * operator, demo and tokenised surface is not.
 *
 * The disallow list is deliberately explicit rather than clever — a crawler
 * reading this file is the same audience as a reviewer reading the site, and
 * both should be able to see exactly which parts of Swift are public.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: '*',
        // The deletion page MUST stay crawlable — Google Play's policy requires a
        // publicly reachable URL, and a bare `Disallow: /account` would swallow it
        // as a prefix. The longer Allow wins, so it is listed explicitly first.
        allow: ['/', '/account/delete'],
        disallow: [
          '/dashboard/',   // vendor operator console
          '/portal/',      // mover document portal
          '/account',      // signed-in customer account (NOT /account/delete — allowed above)
          '/cart',
          '/orders/',
          '/order/',
          '/login',
          '/signup',
          '/selfie',
          '/trip/',        // tokenised trip share — private by construction
          '/track/',       // tokenised parcel tracking — private by construction
          '/qr/',          // QR lifecycle states, not content
          '/api/',
          '/well-known/',  // served at /.well-known/* via rewrite; the internal path is not content
        ],
      },
    ],
    sitemap: `${SITE_ORIGIN}/sitemap.xml`,
    host: SITE_ORIGIN,
  };
}
