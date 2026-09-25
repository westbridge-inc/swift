import type { MetadataRoute } from 'next';
import { appChrome } from '@/lib/design-tokens';
import { launch } from '@/site.config';

/**
 * [PWA-1] The web app manifest — what makes the site installable, so Swift can
 * sit on a home screen and open like an app, without the browser's bars.
 *
 * Served by Next at /manifest.webmanifest and linked from every page's head.
 *
 * - `start_url` is the customer app's Home (/), the page the header logo
 *   returns to. `?source=pwa` marks a launch from the installed icon in request
 *   logs; nothing reads the query, and the sign-in redirect keeps only the path.
 * - `id` is pinned separately, so changing the start URL can never turn one
 *   installed app into two. [Q7b] That is exactly what happened here: Home
 *   moved from /order to /, the start URL followed it, and the id stayed
 *   '/order' — every phone that installed the first version keeps one app.
 * - `scope` is the whole site: sign-in, the legal pages and the store pages all
 *   stay inside the app window instead of bouncing out to a browser tab.
 *
 * The icons are the native app's own artwork, resized from
 * apps/mobile/assets/icon.png ("any") and adaptive-icon-foreground.png
 * ("maskable": the same mark padded into the mask's safe zone, so a circular or
 * squircle mask never clips a wingtip). Regenerate them from those two files
 * whenever the mark changes. Colours come from the token object — see appChrome.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    id: '/order',
    name: 'Swift',
    short_name: 'Swift',
    description: `Food, groceries and more from businesses in ${launch.markets[0]} — pay the business directly, cash or MMG.`,
    lang: 'en-GY',
    start_url: '/?source=pwa',
    scope: '/',
    display: 'standalone',
    orientation: 'portrait',
    background_color: appChrome.background,
    theme_color: appChrome.theme,
    icons: [
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  };
}
