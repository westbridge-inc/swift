import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { DARK_FEATURES, darkFeatureStatus, darkFeaturesOff } from '../modules/ops/dark-features';

// ---------------------------------------------------------------------------
// A capability may ship switched off. It may not ship switched off SILENTLY.
//
// Two shipped that way, and neither failed anything:
//
//   CATEGORY_DISCOVERY_ENABLED defaults false and nothing had ever set it, so
//   the category rail was dark in every database that has ever existed while
//   the client rendered the pre-rail Home pixel-identically.
//
//   APPLE_TEAM_ID / ANDROID_CERT_SHA256 gate the association files that make a
//   printed QR code open the app. Both 404 without them, the QR growth engine
//   quietly degrades to opening a browser tab, and neither variable appeared
//   in any .env.example — so no document would have told anyone to set them.
// ---------------------------------------------------------------------------

const ROOT = join(process.cwd(), '../..');
const read = (rel: string) => (existsSync(join(ROOT, rel)) ? readFileSync(join(ROOT, rel), 'utf8') : '');

describe('[dark features] every silent switch is registered', () => {
  it('names a setting, and says what a PERSON sees while it is off', () => {
    for (const f of DARK_FEATURES) {
      expect(f.setting, `${f.key} has no setting`).toBeTruthy();
      expect(f.whileOff.length, `${f.key} does not describe the experience`).toBeGreaterThan(40);
      // "Feature disabled" is not a consequence. The whole failure mode here is
      // that nothing looks wrong, so the entry has to say what the person sees.
      expect(/disabled|turned off|not enabled/i.test(f.whileOff), `${f.key} restates the switch instead of the consequence`).toBe(false);
    }
  });

  it('reads env switches, and never reports an unresolved config switch as ON', () => {
    const on = darkFeatureStatus({ ANDROID_CERT_SHA256: 'AA:BB' }, { CATEGORY_DISCOVERY_ENABLED: true });
    expect(on.find((r) => r.key === 'android_app_links')!.on).toBe(true);
    expect(on.find((r) => r.key === 'category_discovery')!.on).toBe(true);
    // A config switch with no answer supplied is NOT on.
    expect(darkFeatureStatus({}, {}).find((r) => r.key === 'category_discovery')!.on).toBe(false);
    expect(darkFeaturesOff(darkFeatureStatus({}, {})).map((r) => r.key)).toContain('android_app_links');
  });

  it('whitespace is not a fingerprint', () => {
    expect(darkFeatureStatus({ ANDROID_CERT_SHA256: '   ' }).find((r) => r.key === 'android_app_links')!.on).toBe(false);
  });

  it('a capability the CODE defaults is reported ON, with or without env', () => {
    // The mirror-image lie. A register that reports a capability off when the
    // code defaults it on sends an operator to fix something that is not
    // broken — and the next warning it prints gets ignored.
    //
    // iOS universal links are the live case: Swift's Team ID is now the default
    // in the AASA route, so the file serves with no configuration at all. The
    // env var still overrides it, which is why the entry stays registered.
    const ios = darkFeatureStatus({}, {}).find((r) => r.key === 'ios_universal_links')!;
    expect(ios.defaultedInCode, 'the entry claims no code default').toBeTruthy();
    expect(ios.on).toBe(true);
    expect(darkFeaturesOff(darkFeatureStatus({}, {})).map((r) => r.key)).not.toContain('ios_universal_links');
  });

  it('every claimed code default names where it lives, and is really there', () => {
    // A register entry may not simply ASSERT that the code defaults something.
    // That is the same unverified claim as a comment describing a gate — the
    // shape of defect this whole file exists to catch.
    for (const f of DARK_FEATURES.filter((x) => x.defaultedInCode)) {
      const parts = f.defaultedInCode!.split(' ');
      const value = parts[0] ?? '';
      const where = parts.slice(2).join(' ');
      expect(value, `${f.key} does not name the default value`).toBeTruthy();
      expect(where, `${f.key} does not say where the default lives`).toBeTruthy();
      const hay = [
        read('apps/web/src/app/well-known/apple-app-site-association/route.ts'),
        read('apps/web/src/app/well-known/assetlinks.json/route.ts'),
      ].join('\n');
      expect(hay.includes(value), `${f.key} claims a default of "${value}" that is nowhere in the code`).toBe(true);
    }
  });
});

describe('[dark features] the registry matches the code that reads the switch', () => {
  it('each env switch is actually read somewhere', () => {
    // A registry entry for a variable nothing consults is worse than no entry:
    // it tells an operator they have turned something on when they have not.
    const sources = [
      read('apps/web/src/app/well-known/apple-app-site-association/route.ts'),
      read('apps/web/src/app/well-known/assetlinks.json/route.ts'),
      read('apps/api/src/modules/safety/sos-escalation.ts'),
      read('apps/api/src/modules/discovery/discovery.routes.ts'),
    ].join('\n');
    expect(sources.length, 'could not read the sources — the check cannot run').toBeGreaterThan(500);
    for (const f of DARK_FEATURES) {
      expect(sources.includes(f.setting), `${f.setting} is registered but nothing reads it`).toBe(true);
    }
  });

  it('every registered switch is documented where an operator would look', () => {
    // The gap that made these invisible was not the code — it was that no
    // .env.example mentioned them, so there was no document to consult.
    const docs = [read('apps/web/.env.example'), read('apps/mobile/.env.example'), read('apps/api/.env.example')].join('\n');
    for (const f of DARK_FEATURES.filter((x) => x.source === 'env')) {
      expect(docs.includes(f.setting), `${f.setting} appears in no .env.example — nothing would tell an operator it exists`).toBe(true);
    }
  });
});
