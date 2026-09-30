import type { MetadataRoute } from 'next';
import { SITE_ORIGIN } from '@/site.config';

/**
 * [SITE-1.1 Part 5 / AC-11, AX295] Public pages are crawlable and indexable.
 * Ordinary private pages are crawlable so search engines can read their
 * noindex metadata, including on the sign-in door. Disallow would hide that
 * directive and could leave an externally linked URL indexed without content.
 *
 * Secret-token and GET-side-effect routes instead keep BOTH Disallow and
 * noindex. These include tracking/share pages and the configured /s/ rewrite,
 * whose resolver records a scan on GET. The route census requires any new
 * payment return, magic or invite link to be classified explicitly. Auth and
 * access controls remain the data boundary.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: '*',
        allow: '/',
        disallow: [
          '/pay/mmg/',     // token-bearing payment returns
          '/trip/',        // tokenised trip share — private by construction
          '/track/',       // tokenised parcel tracking — private by construction
          '/s/',           // QR resolver records a scan on GET [AX303 F3]
          '/api/',
        ],
      },
    ],
    sitemap: `${SITE_ORIGIN}/sitemap.xml`,
    host: SITE_ORIGIN,
  };
}
