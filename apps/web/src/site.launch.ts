// ─────────────────────────────────────────────────────────────────────────────
//  [#1756 perf-budget] The launch truth lives in its own small module so a client page that only needs it
//  (sign-up reads launch.markets through lib/web-ordering) does not also download the company facts in
//  site.config.ts. site.config.ts re-exports it: every existing import keeps working.
// ─────────────────────────────────────────────────────────────────────────────
// ── Launch truth ───────────────────────────────────────────────────────────
//  Every availability claim on the site reads from here, so the marketing copy
//  can never drift ahead of what actually works. Apple and Google both treat a
//  dead call-to-action as a review flag, and a "Download on the App Store"
//  badge before the app exists is the fastest way to fail.
//
//  Flip a vertical to 'live' only when a customer in that market can complete
//  the flow end to end today.

export type LaunchState = 'live' | 'waitlist' | 'soon';

export const launch = {
  /** Where the product actually operates. Add a market only when it is real. */
  markets: ['Georgetown, Guyana'] as const,

  // [Item 7 · S1] THE pre-launch switch for the PUBLIC site is no longer a
  // build-time value here: the web server reads it while it runs
  // (src/lib/launch-switch.ts, SWIFT_WEB_ORDERING), so opening or closing
  // ordering needs a restart with the new setting, never a rebuild.
  // [G11] The same for the App Store and Google Play links: SWIFT_APP_STORES,
  // read while the server runs (src/lib/launch-switch.ts), turned on at
  // Release once both stores show the app live.

  verticals: {
    food: 'live' as LaunchState,
    groceries: 'live' as LaunchState,
    shops: 'live' as LaunchState,
    rides: 'live' as LaunchState,
    courier: 'live' as LaunchState,
    services: 'live' as LaunchState,
  },

  /** [Q36] Visa and Mastercard, through the bank's card gateway, for Swift's
   *  OWN charges — the weekly partner fee, and advertising a business chooses
   *  to buy. Orders are never paid by card: the
   *  API accepts only cash or the store's own MMG for an order. Flip to 'live'
   *  only when a partner can pay the weekly fee by card end to end; until then
   *  every card mark on the site says "coming soon". */
  cardPayments: 'soon' as LaunchState,
} as const;
