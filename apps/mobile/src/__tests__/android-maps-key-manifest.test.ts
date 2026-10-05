import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';

/**
 * THE KEY MUST REACH THE ANDROID MANIFEST, NOT JUST THE CONFIG OBJECT.
 *
 * Found on an Android emulator with the staging preview APK: Taxi, "Drop the
 * pin on the map" and the driver preview all crashed with
 *
 *   java.lang.RuntimeException: API key not found. Check that <meta-data
 *   android:name="com.google.android.geo.API_KEY" .../> is in the <application>
 *
 * although the key was set for that EAS build. The key gate passed because the
 * env var existed, so `android.config.googleMaps.apiKey` held it. But
 * react-native-maps ships its own config plugin, and Expo hands that plugin the
 * manifest instead of its built-in Google Maps step. That plugin writes the
 * meta-data only from its own `androidGoogleMapsApiKey` option, and REMOVES it
 * when the option is missing. So the key never reached the APK.
 *
 * android-maps-key-gate.test.ts reads app.config.ts as text and could not see
 * this. This file runs the real Expo plugin pipeline in introspect mode (it
 * reads the config, compiles the Android mods in memory, and writes nothing)
 * and asserts on the manifest an EAS build would produce. Each compile runs in
 * its own Node process with an explicit environment, because Expo's config
 * loader caches the evaluated app.config.ts for the life of a process.
 */

const MOBILE = process.cwd();
const GEO_KEY = 'com.google.android.geo.API_KEY';

type MetaData = { name: string; value?: string };

// Expo's own build packages, resolved the way `expo prebuild` and EAS resolve
// them: through the installed `expo`.
const COMPILE = `
const { createRequire } = require('node:module');
const path = require('node:path');
const root = process.cwd();
const fromExpo = createRequire(createRequire(path.join(root, 'package.json')).resolve('expo/package.json'));
const { getPrebuildConfigAsync } = fromExpo('@expo/prebuild-config');
const { compileModsAsync } = fromExpo('@expo/config-plugins');
(async () => {
  const { exp } = await getPrebuildConfigAsync(root, { platforms: ['android'] });
  const out = await compileModsAsync(exp, { projectRoot: root, introspect: true, platforms: ['android'], assertMissingModProviders: false });
  const app = out._internal.modResults.android.manifest.manifest.application[0];
  const meta = (app['meta-data'] || []).map((m) => ({ name: m.$['android:name'], value: m.$['android:value'] }));
  process.stdout.write('\\n@@META@@' + JSON.stringify(meta));
})().catch((e) => { console.error(e); process.exit(1); });
`;

// The public config is what the app embeds and serves as Constants.expoConfig.
const PUBLIC = `
const { createRequire } = require('node:module');
const path = require('node:path');
const root = process.cwd();
const fromExpo = createRequire(createRequire(path.join(root, 'package.json')).resolve('expo/package.json'));
const { getConfig } = fromExpo('@expo/config');
process.stdout.write('\\n@@META@@' + JSON.stringify(getConfig(root, { isPublicConfig: true, skipSDKVersionRequirement: true }).exp));
`;

function runIsolated(script: string, env: Record<string, string>): string {
  const inherited = { ...process.env };
  for (const name of ['ANDROID_GOOGLE_MAPS_API_KEY', 'EAS_BUILD', 'EAS_BUILD_PLATFORM', 'CI', 'GOOGLE_SERVICES_JSON']) {
    delete inherited[name];
  }
  const stdout = execFileSync(process.execPath, ['-e', script], {
    cwd: MOBILE,
    env: { ...inherited, ...env },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return stdout.slice(stdout.lastIndexOf('@@META@@') + '@@META@@'.length);
}

function compiledAndroidMetaData(env: Record<string, string>): MetaData[] {
  return JSON.parse(runIsolated(COMPILE, env)) as MetaData[];
}

describe('the Google Maps key reaches the Android manifest', () => {
  it('a build given the key writes it into <application> meta-data', () => {
    const metaData = compiledAndroidMetaData({
      EAS_BUILD_PLATFORM: 'android',
      ANDROID_GOOGLE_MAPS_API_KEY: 'qa-test-maps-key-not-real',
    });
    const key = metaData.find((entry) => entry.name === GEO_KEY);

    expect(key, `${GEO_KEY} is missing, so every MapView screen crashes natively`).toBeDefined();
    expect(key!.value).toBe('qa-test-maps-key-not-real');
  }, 60_000);

  it('a local build with no key writes none (the gate only warns there)', () => {
    const metaData = compiledAndroidMetaData({ EAS_BUILD_PLATFORM: 'android' });

    expect(metaData.map((entry) => entry.name)).not.toContain(GEO_KEY);
  }, 60_000);

  it('an iOS build never carries the Android key, not even in its embedded public config', () => {
    // The iOS app has no Google Maps at all. Expo strips android.config from the
    // public config, but not plugin options, so the option must not be set on iOS.
    const publicConfig = runIsolated(PUBLIC, {
      EAS_BUILD_PLATFORM: 'ios',
      ANDROID_GOOGLE_MAPS_API_KEY: 'qa-test-maps-key-not-real',
    });

    expect(publicConfig.length).toBeGreaterThan(100);
    expect(publicConfig).not.toContain('qa-test-maps-key-not-real');
  }, 60_000);

  it('with no build platform set (a local or CI export), the public config never carries the key', () => {
    // Only EAS states the platform. Anything else, such as
    // `expo export --platform ios` in CI, must not put the key into the
    // embedded config, even though the missing-key gate stays strict there.
    const publicConfig = runIsolated(PUBLIC, { ANDROID_GOOGLE_MAPS_API_KEY: 'qa-test-maps-key-not-real' });

    expect(publicConfig.length).toBeGreaterThan(100);
    expect(publicConfig).not.toContain('qa-test-maps-key-not-real');
  }, 60_000);

  it('the missing-key gate stays strict when the platform is unset, and lets an iOS build through', () => {
    // Behaviour, not text: a distributable build with no key and no stated
    // platform must refuse to evaluate the config (CI builds both platforms).
    expect(() => runIsolated(PUBLIC, { EAS_BUILD: 'true' })).toThrow(/ANDROID_GOOGLE_MAPS_API_KEY/);
    expect(() => runIsolated(PUBLIC, { EAS_BUILD: 'true', EAS_BUILD_PLATFORM: 'android' })).toThrow(/ANDROID_GOOGLE_MAPS_API_KEY/);
    expect(runIsolated(PUBLIC, { EAS_BUILD: 'true', EAS_BUILD_PLATFORM: 'ios' }).length).toBeGreaterThan(100);
  }, 90_000);
});
