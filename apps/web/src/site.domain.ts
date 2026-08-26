/**
 * The canonical host, alone, with no side effects.
 *
 * `next.config.ts` needs the domain to build the www→apex redirect, and Next
 * loads that config during `next lint`, `next dev` and `next build` alike.
 * Importing the full site.config there would fire its unfilled-token guard
 * during ordinary tooling — which is how `pnpm lint` started failing.
 *
 * So the domain lives here on its own: infrastructure, not company identity.
 * Every company fact still lives in exactly one file, site.config.ts.
 */
export const SITE_DOMAIN = 'swiftgy.com' as const;
export const SITE_ORIGIN = `https://${SITE_DOMAIN}` as const;
