import type { MetadataRoute } from 'next';
import { SITE_ORIGIN } from '@/site.config';

/**
 * [SITE-1.1 Part 5 / AC-11, AX295] Public pages are crawlable and indexable.
 * Ordinary private pages are crawlable so search engines can read their
 * noindex metadata, including on the sign-in door. Disallow would hide that
 * directive and could leave an externally linked URL indexed without content.
 *
 * Secret-token and GET-side-effect routes instead keep BOTH Disallow and
 * noindex. The only such pages currently in this app are tracking/share links;
 * the route census requires any new payment return, magic or invite link to
 * be classified explicitly. Auth and access controls remain the data boundary.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: '*',
        allow: '/',
        disallow: [
          '/trip/',        // tokenised trip share — private by construction
          '/track/',       // tokenised parcel tracking — private by construction
          '/api/',
        ],
      },
    ],
    sitemap: `${SITE_ORIGIN}/sitemap.xml`,
    host: SITE_ORIGIN,
  };
}
