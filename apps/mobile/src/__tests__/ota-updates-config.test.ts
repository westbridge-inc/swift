import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * [L13 item 7 · owner decision 4] Over-the-air updates for build 10.
 * The update server, the runtime pin and the safe launch behaviour are graded
 * here; the channel comes from the EAS build profile.
 */
type AppConfig = {
  version: string;
  runtimeVersion?: unknown;
  updates?: Record<string, unknown>;
  plugins: unknown[];
  ios: { privacyManifests: { NSPrivacyCollectedDataTypes: Record<string, unknown>[] } };
  extra: Record<string, unknown>;
};

const MOBILE = process.cwd();
const PROJECT_ID = 'bb17a405-1f85-4384-9186-25de0319122b';

async function loadConfig(): Promise<AppConfig> {
  return (await import('../../app.config')).default as unknown as AppConfig;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('over-the-air updates (L13 item 7)', () => {
  it('pins the runtime to the app version explicitly', async () => {
    vi.stubEnv('ANDROID_GOOGLE_MAPS_API_KEY', 'test-maps-key');
    vi.stubEnv('EAS_PROJECT_ID', PROJECT_ID);
    const config = await loadConfig();
    expect(config.runtimeVersion).toEqual({ policy: 'appVersion' });
  });

  it('an EAS build points at its project\'s update server and never blocks launch on the network', async () => {
    vi.stubEnv('ANDROID_GOOGLE_MAPS_API_KEY', 'test-maps-key');
    vi.stubEnv('EAS_PROJECT_ID', PROJECT_ID);
    const config = await loadConfig();
    expect(config.updates).toEqual({
      enabled: true,
      url: `https://u.expo.dev/${PROJECT_ID}`,
      checkAutomatically: 'ON_LOAD',
      fallbackToCacheTimeout: 0,
    });
    expect(config.extra['eas']).toEqual({ projectId: PROJECT_ID });
  });

  it('a build without a project id has updates OFF, not pointed at nothing', async () => {
    vi.stubEnv('ANDROID_GOOGLE_MAPS_API_KEY', 'test-maps-key');
    vi.stubEnv('EAS_PROJECT_ID', undefined);
    const config = await loadConfig();
    expect(config.updates).toEqual({ enabled: false });
    expect(config.extra).not.toHaveProperty('eas');
  });

  it('the store build profile publishes to the production channel with the same project id', () => {
    const eas = JSON.parse(readFileSync(join(MOBILE, 'eas.json'), 'utf8')) as {
      build: Record<string, { channel?: string; env?: Record<string, string> }>;
    };
    expect(eas.build['production']!.channel).toBe('production');
    expect(eas.build['production']!.env?.['EAS_PROJECT_ID']).toBe(PROJECT_ID);
  });

  it('the update and crash-report SDKs are the official packages at Expo 56 compatible versions', () => {
    const pkg = JSON.parse(readFileSync(join(MOBILE, 'package.json'), 'utf8')) as { dependencies: Record<string, string> };
    expect(pkg.dependencies['expo-updates']).toMatch(/^~56\.0\.\d+$/);
    expect(pkg.dependencies['@sentry/react-native']).toMatch(/^~7\.11\.\d+$/);
  });
});

describe('crash reports in the iOS privacy manifest (L13 item 7)', () => {
  it('declares crash data, not linked to the user and not tracking', async () => {
    vi.stubEnv('ANDROID_GOOGLE_MAPS_API_KEY', 'test-maps-key');
    const config = await loadConfig();
    const crash = config.ios.privacyManifests.NSPrivacyCollectedDataTypes.find(
      (entry) => entry['NSPrivacyCollectedDataType'] === 'NSPrivacyCollectedDataTypeCrashData',
    );
    expect(crash).toEqual({
      NSPrivacyCollectedDataType: 'NSPrivacyCollectedDataTypeCrashData',
      NSPrivacyCollectedDataTypeLinked: false,
      NSPrivacyCollectedDataTypeTracking: false,
      NSPrivacyCollectedDataTypePurposes: ['NSPrivacyCollectedDataTypePurposeAppFunctionality'],
    });
  });

  it('adds no build-time Sentry plugin, so a build never needs an upload token to succeed', async () => {
    vi.stubEnv('ANDROID_GOOGLE_MAPS_API_KEY', 'test-maps-key');
    const config = await loadConfig();
    const names = config.plugins.map((p) => (Array.isArray(p) ? p[0] : p));
    expect(names.filter((n) => typeof n === 'string' && n.includes('sentry'))).toEqual([]);
  });
});

// [BUILD-12 · rows 352 + 477] The privacy manifest ships INSIDE the binary (ios/ is regenerated from
// app.config.ts at each build), so it can only be corrected by a new build, never over the air. It must
// name every kind of data the app keeps, matching the App Privacy answers in App Store Connect.
describe('the iOS privacy manifest names every kind of data the app keeps (build 12)', () => {
  const entryOf = (config: AppConfig, type: string) =>
    config.ios.privacyManifests.NSPrivacyCollectedDataTypes.find(
      (entry) => entry['NSPrivacyCollectedDataType'] === `NSPrivacyCollectedDataType${type}`,
    );
  const linkedForTheApp = (type: string) => ({
    NSPrivacyCollectedDataType: `NSPrivacyCollectedDataType${type}`,
    NSPrivacyCollectedDataTypeLinked: true,
    NSPrivacyCollectedDataTypeTracking: false,
    NSPrivacyCollectedDataTypePurposes: ['NSPrivacyCollectedDataTypePurposeAppFunctionality'],
  });

  it('declares the MMG number, pay link and payment reference a store keeps (Other Financial Info, linked)', async () => {
    vi.stubEnv('ANDROID_GOOGLE_MAPS_API_KEY', 'test-maps-key');
    expect(entryOf(await loadConfig(), 'OtherFinancialInfo')).toEqual(linkedForTheApp('OtherFinancialInfo'));
  });

  it('declares the emergency contacts a person saves for SOS (Contacts, linked)', async () => {
    vi.stubEnv('ANDROID_GOOGLE_MAPS_API_KEY', 'test-maps-key');
    expect(entryOf(await loadConfig(), 'Contacts')).toEqual(linkedForTheApp('Contacts'));
  });

  it('declares a driver\'s vehicle details (Other Data Types, linked)', async () => {
    vi.stubEnv('ANDROID_GOOGLE_MAPS_API_KEY', 'test-maps-key');
    expect(entryOf(await loadConfig(), 'OtherDataTypes')).toEqual(linkedForTheApp('OtherDataTypes'));
  });

  it('declares the app-hang reports the crash SDK sends (Performance Data, not linked, not tracking)', async () => {
    vi.stubEnv('ANDROID_GOOGLE_MAPS_API_KEY', 'test-maps-key');
    expect(entryOf(await loadConfig(), 'PerformanceData')).toEqual({
      NSPrivacyCollectedDataType: 'NSPrivacyCollectedDataTypePerformanceData',
      NSPrivacyCollectedDataTypeLinked: false,
      NSPrivacyCollectedDataTypeTracking: false,
      NSPrivacyCollectedDataTypePurposes: ['NSPrivacyCollectedDataTypePurposeAppFunctionality'],
    });
  });

  it('is exactly the reviewed list, nothing is tracking, and the app does not track', async () => {
    vi.stubEnv('ANDROID_GOOGLE_MAPS_API_KEY', 'test-maps-key');
    const config = await loadConfig();
    const manifest = config.ios.privacyManifests as unknown as {
      NSPrivacyTracking: boolean;
      NSPrivacyCollectedDataTypes: Record<string, unknown>[];
    };
    expect(manifest.NSPrivacyTracking).toBe(false);
    const types = manifest.NSPrivacyCollectedDataTypes.map((e) =>
      String(e['NSPrivacyCollectedDataType']).replace('NSPrivacyCollectedDataType', ''),
    );
    expect([...types].sort()).toEqual([
      'Contacts', 'CrashData', 'CustomerSupport', 'DeviceID', 'EmailAddress', 'Name', 'OtherDataTypes', 'OtherFinancialInfo',
      'OtherUserContent', 'PerformanceData', 'PhoneNumber', 'PhotosorVideos', 'PhysicalAddress', 'PreciseLocation',
      'PurchaseHistory', 'SensitiveInfo', 'UserID',
    ]);
    expect(manifest.NSPrivacyCollectedDataTypes.every((e) => e['NSPrivacyCollectedDataTypeTracking'] === false)).toBe(true);
  });
});
