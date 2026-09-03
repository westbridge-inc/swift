/**
 * [R048-007] THE SENSITIVE-ROUTE REGISTRY. Every route that moves money
 * authority (an MMG pay link staged, cleared or cancelled) is listed here
 * with the controls it must carry, by the source text of the control call.
 * A census test proves two things: every listed route carries every listed
 * control, and every money-surface call in the route tree sits inside a
 * listed route. An unlisted sensitive route is a test failure, not a gap
 * nobody noticed.
 */
export interface SensitiveRoute {
  /** Route file, relative to src/. */
  file: string;
  /** The route's registration line prefix, e.g. `app.put('/profile'`. */
  route: string;
  surface: 'mmg-link';
  /** Source text each control must appear as, inside the route's handler. */
  controls: string[];
}

export const SENSITIVE_MONEY_ROUTES: SensitiveRoute[] = [
  { file: 'modules/vendor/vendor.routes.ts', route: "app.put('/profile'", surface: 'mmg-link', controls: ['requireStepUp(app, request)', "assertVelocity(app, request, 'money.mmg-link')", 'stageMmgLinkChange({ prisma: app.prisma, io: app.io, redis: app.redis }'] },
  { file: 'modules/vendor/vendor.routes.ts', route: "app.delete('/profile/mmg-pay-url/pending'", surface: 'mmg-link', controls: ["assertVelocity(app, request, 'money.mmg-link.cancel')", 'cancelMmgLinkChange({ prisma: app.prisma, io: app.io, redis: app.redis }'] },
  { file: 'modules/driver/driver.routes.ts', route: "app.put('/profile'", surface: 'mmg-link', controls: ['requireStepUp(app, request)', "assertVelocity(app, request, 'money.mmg-link')", 'stageMmgLinkChange({ prisma: app.prisma, io: app.io, redis: app.redis }'] },
  { file: 'modules/driver/driver.routes.ts', route: "app.delete('/profile/mmg-pay-url/pending'", surface: 'mmg-link', controls: ["assertVelocity(app, request, 'money.mmg-link.cancel')", 'cancelMmgLinkChange({ prisma: app.prisma, io: app.io, redis: app.redis }'] },
];

/** The money-surface calls whose every occurrence in a route file must sit inside a listed route. */
export const MONEY_SURFACE_CALLS = ['stageMmgLinkChange(', 'cancelMmgLinkChange(', 'clearMmgLink('] as const;
