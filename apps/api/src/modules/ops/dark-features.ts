/**
 * The capabilities that fail QUIETLY.
 *
 * The boot guards in `boot-config.ts` cover the loud half: a missing KEK, a dev
 * SMS provider, an unset signing secret — the server refuses to start and says
 * why. `deploy/preflight.ts` runs those same guards against a candidate .env,
 * so nothing in that class can reach production unnoticed.
 *
 * This is the other half, and it has cost more real time than the loud one.
 *
 * A capability that is configured OFF does not fail. It renders a fallback,
 * returns an empty list, or 404s a file nobody looks at — and every layer above
 * behaves exactly as designed. Two examples, both found by measurement rather
 * than by anything failing:
 *
 *   • `CATEGORY_DISCOVERY_ENABLED` defaults to false and NOTHING had ever set
 *     it — not the spine, not a migration, not a script. The rail was dark in
 *     every database that has ever existed, returning `{enabled:false,
 *     categories:[]}` while the client rendered the pre-rail Home
 *     pixel-identically, exactly as its kill-switch was designed to behave.
 *     Nothing looked broken because the fallback is deliberately invisible.
 *
 *   • `APPLE_TEAM_ID` / `ANDROID_CERT_SHA256` gate the two association files
 *     that make a printed QR code open the APP instead of a browser tab. Both
 *     routes 404 without them — correctly, since a fake association is worse
 *     than none — and the whole QR growth engine silently degrades to opening
 *     Safari. Neither variable appeared in any .env.example or deploy note, so
 *     there was no document that would have told anyone to set them.
 *
 * The rule this file encodes: a capability may ship switched off, but it may
 * not ship switched off SILENTLY. Every entry names the env or config that
 * turns it on, and states what a real person sees while it is off.
 */

export type DarkFeatureImpact = 'growth' | 'product' | 'ops';

export interface DarkFeature {
  key: string;
  /** The env var or PlatformConfig key that turns it on. */
  setting: string;
  source: 'env' | 'config';
  title: string;
  /** What a real person experiences while this is off. Never "feature disabled". */
  whileOff: string;
  impact: DarkFeatureImpact;
  /**
   * The code already carries a working default, so this is ON without any env.
   *
   * A register that reports a capability OFF when the code defaults it ON is
   * the same lie it exists to prevent, pointed the other way — it sends an
   * operator to fix something that is not broken, and the next warning gets
   * ignored. The env var still overrides; this only records that its absence
   * is not an absence of the feature.
   */
  defaultedInCode?: string;
}

export const DARK_FEATURES: DarkFeature[] = [
  {
    key: 'ios_universal_links',
    setting: 'APPLE_TEAM_ID',
    source: 'env',
    title: 'iOS universal links',
    whileOff:
      'A printed QR code or a shared storefront link opens Safari instead of the app, even on a phone that has Swift installed, and /.well-known/apple-app-site-association returns 404.',
    // Swift's own Team ID is now the default in the AASA route, so this is on
    // everywhere without configuration. It is kept in the register because the
    // env var still overrides it — a fork or a second Apple account needs to
    // know this switch exists — and because the outage it describes is exactly
    // what happened while the route had no default.
    defaultedInCode: 'N3JV22LC84 in apps/web … apple-app-site-association/route.ts',
    impact: 'growth',
  },
  {
    key: 'android_app_links',
    setting: 'ANDROID_CERT_SHA256',
    source: 'env',
    title: 'Android app links',
    whileOff:
      'The same link opens Chrome instead of the app. /.well-known/assetlinks.json returns 404. Needs the RELEASE keystore SHA-256, colon-separated.',
    impact: 'growth',
  },
  {
    key: 'category_discovery',
    setting: 'CATEGORY_DISCOVERY_ENABLED',
    source: 'config',
    title: 'The category rail',
    whileOff:
      'Home and Market render with no category chips at all — the pre-rail layout, pixel-identical, so it reads as a design choice rather than a switch that is off.',
    impact: 'product',
  },
  {
    key: 'guardian_contact_sms',
    setting: 'GUARDIAN_AUTONOTIFY_CONTACTS',
    source: 'env',
    title: 'Guardian check-in contact SMS',
    whileOff:
      'An alert raised by an UNANSWERED check-in pages ops but does not text the emergency contacts. This is the deliberate default (§5.3 L4 — the server guessing, not a person asking) and is recorded as a receipt, not a silence.',
    impact: 'ops',
  },
];

export interface DarkFeatureStatus extends DarkFeature {
  on: boolean;
}

/** Read the env half. Config-sourced entries need a database and are resolved
 *  by the caller that has one — `unknown` is never reported as `on`. */
export function darkFeatureStatus(
  env: Record<string, string | undefined> = process.env,
  configOn: Record<string, boolean> = {},
): DarkFeatureStatus[] {
  return DARK_FEATURES.map((f) => ({
    ...f,
    on: f.defaultedInCode
      ? true
      : f.source === 'env'
        ? Boolean(env[f.setting]?.trim())
        : configOn[f.setting] === true,
  }));
}

export const darkFeaturesOff = (rows: DarkFeatureStatus[]): DarkFeatureStatus[] => rows.filter((r) => !r.on);
