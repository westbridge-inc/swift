/**
 * [W2] The two faces every page paints first — body text (Hanken 400) and the
 * titles (Bricolage 700). The root layout asks for them with the page itself
 * instead of after the stylesheet is read, so text appears in its own face
 * sooner on a slow line. They are self-hosted, so the CSP's `font-src 'self'`
 * is unchanged; every other weight still loads only when a page uses it.
 */
export const PRELOADED_FONTS = ['/fonts/hanken-grotesk-400.woff2', '/fonts/bricolage-grotesque-700.woff2'] as const;
