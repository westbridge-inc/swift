import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// [QR spec Part 6] The two files that decide whether a printed QR code opens
// the APP or a browser tab — and the four places whose answers must agree.
//
// iOS fetches /.well-known/apple-app-site-association and Android fetches
// /.well-known/assetlinks.json, once, at install. If the identity in either
// file does not match the identity the installed app declares, verification
// fails and the link opens a browser — permanently, silently, with no error
// anywhere. There is no runtime signal at all: the app simply never opens.
//
// So the identity lives in four places that can drift:
//
//   apps/web  … apple-app-site-association   TEAM_ID + BUNDLE_ID
//   apps/web  … assetlinks.json              ANDROID package
//   apps/mobile/app.config.ts                bundleIdentifier + package
//   apps/mobile/eas.json                     submit.ios.appleTeamId
//
// This grades that they still say the same thing. It is the cheapest possible
// guard against a failure whose only symptom is a growth engine that quietly
// stops working.
// ---------------------------------------------------------------------------

const ROOT = join(process.cwd(), '../..');
const read = (rel: string) => {
  const p = join(ROOT, rel);
  return existsSync(p) ? readFileSync(p, 'utf8') : '';
};

const AASA = read('apps/web/src/app/well-known/apple-app-site-association/route.ts');
const ASSETLINKS = read('apps/web/src/app/well-known/assetlinks.json/route.ts');
const APP_CONFIG = read('apps/mobile/app.config.ts');
const EAS = read('apps/mobile/eas.json');

/** `const NAME = process.env['X'] ?? 'value';` → 'value' */
const defaultOf = (src: string, name: string): string | null =>
  src.match(new RegExp(`const ${name} = process\\.env\\['[A-Z_]+'\\] \\?\\? '([^']+)'`))?.[1] ?? null;

describe('[deep links] the sources it can read', () => {
  it('can read all four', () => {
    // UNVERIFIED beats a fake PASS: a drift check that cannot see its inputs
    // must say so, not report green.
    for (const [name, src] of Object.entries({ AASA, ASSETLINKS, APP_CONFIG, EAS })) {
      expect(src.length, `${name} could not be read — the drift check cannot run`).toBeGreaterThan(100);
    }
  });
});

describe('[deep links] one identity, four files', () => {
  it('the iOS bundle id is the same on both sides of the association', () => {
    const served = defaultOf(AASA, 'BUNDLE_ID');
    const declared = APP_CONFIG.match(/bundleIdentifier: '([^']+)'/)?.[1];
    expect(served, 'no bundle id default in the AASA route').toBeTruthy();
    expect(declared, 'no bundleIdentifier in app.config.ts').toBeTruthy();
    expect(served).toBe(declared);
  });

  it('the Android package is the same on both sides', () => {
    const served = defaultOf(ASSETLINKS, 'PACKAGE');
    const declared = APP_CONFIG.match(/^\s*package: '([^']+)'/m)?.[1];
    expect(served).toBeTruthy();
    expect(declared).toBeTruthy();
    expect(served).toBe(declared);
  });

  it('the Apple Team ID the web serves is the one the build submits under', () => {
    // If these disagree, the association names an app that was signed by a
    // different team — which is precisely the case iOS refuses to verify.
    const served = defaultOf(AASA, 'TEAM_ID');
    const submitted = (JSON.parse(EAS) as {
      submit?: { production?: { ios?: { appleTeamId?: string } } };
    }).submit?.production?.ios?.appleTeamId;
    expect(served, 'the AASA route has no Team ID default').toBeTruthy();
    expect(submitted, 'eas.json carries no appleTeamId').toBeTruthy();
    expect(served).toBe(submitted);
  });

  it('the Team ID is a real one, not a placeholder', () => {
    // `REPLACE_WITH_APPLE_TEAM_ID` shipped in eas.json for months. A
    // placeholder that parses as a string is the worst shape of missing value:
    // every check that asks "is it set?" says yes.
    const served = defaultOf(AASA, 'TEAM_ID')!;
    expect(/^[A-Z0-9]{10}$/.test(served), `"${served}" is not a 10-character Apple Team ID`).toBe(true);
    expect(EAS).not.toContain('REPLACE_WITH_APPLE_TEAM_ID');
  });
});

describe('[deep links] the association covers the links that are actually printed', () => {
  it('serves the QR short link and the storefront paths in BOTH shapes', () => {
    // `/s/*` is the printed QR short link and `/store/*` is a shared
    // storefront. A path missing here opens a browser tab even though the app
    // is installed and everything else verified.
    //
    // Checked per ARRAY, not with a substring search over the whole file. The
    // association carries the same paths twice on purpose — `components` is
    // the modern (iOS 13+) shape and `paths` is kept for older parsers — and a
    // path that survives in only one of them still reads as present to a naive
    // search while being broken on every current iPhone. An earlier draft of
    // this test made exactly that mistake and a mutation walked straight
    // through it.
    const components = AASA.match(/components: \[([^\]]*)\]/)?.[1] ?? '';
    const paths = AASA.match(/paths: \[([^\]]*)\]/)?.[1] ?? '';
    expect(components, 'no components array in the association').not.toBe('');
    expect(paths, 'no paths array in the association').not.toBe('');
    for (const path of ['/s/*', '/store/*']) {
      expect(components.includes(path), `${path} is missing from components — broken on iOS 13+`).toBe(true);
      expect(paths.includes(path), `${path} is missing from paths — broken on older parsers`).toBe(true);
    }
  });

  it('the app claims the same paths it is being handed', () => {
    // app.config.ts declares intent filters (Android) and associatedDomains
    // (iOS). A path served by the association but not claimed by the app is
    // handed over and then dropped.
    for (const prefix of ['/s', '/store']) {
      expect(APP_CONFIG.includes(`pathPrefix: '${prefix}'`), `the app does not claim ${prefix}`).toBe(true);
    }
    expect(APP_CONFIG).toContain('applinks:');
  });
});
