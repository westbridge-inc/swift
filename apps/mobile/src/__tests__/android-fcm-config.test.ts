import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const MOBILE = process.cwd();
const REPOSITORY = join(MOBILE, '../..');

type AppConfig = {
  android: {
    package?: string;
    googleServicesFile?: unknown;
    adaptiveIcon?: { backgroundColor?: unknown };
    [key: string]: unknown;
  };
  plugins: unknown[];
};

async function loadConfig(): Promise<AppConfig> {
  return (await import('../../app.config')).default as unknown as AppConfig;
}

function notificationPlugin(config: AppConfig): Record<string, unknown> {
  const plugin = config.plugins.find(
    (entry): entry is [string, Record<string, unknown>] =>
      Array.isArray(entry) && entry[0] === 'expo-notifications',
  );
  expect(plugin).toBeDefined();
  return plugin![1];
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('Android FCM build configuration', () => {
  it('uses the EAS-provided Firebase file path when it is available', async () => {
    vi.stubEnv('ANDROID_GOOGLE_MAPS_API_KEY', 'test-maps-key');
    vi.stubEnv('GOOGLE_SERVICES_JSON', '/tmp/eas/google-services.json');

    const config = await loadConfig();

    expect(config.android['googleServicesFile']).toBe('/tmp/eas/google-services.json');
  });

  it('omits the Firebase file setting outside EAS without throwing', async () => {
    vi.stubEnv('ANDROID_GOOGLE_MAPS_API_KEY', 'test-maps-key');
    vi.stubEnv('GOOGLE_SERVICES_JSON', undefined);

    await expect(loadConfig()).resolves.toMatchObject({ android: { package: 'gy.swift.app' } });
    const config = await loadConfig();
    expect(config.android).not.toHaveProperty('googleServicesFile');
  });

  it('routes background FCM v1 notifications to the existing default channel with a monochrome icon', async () => {
    vi.stubEnv('ANDROID_GOOGLE_MAPS_API_KEY', 'test-maps-key');

    const config = await loadConfig();
    const options = notificationPlugin(config);

    expect(options).toMatchObject({
      defaultChannel: 'default',
      icon: './assets/notification-icon.png',
    });
    expect(options['color']).toBe(config.android.adaptiveIcon?.backgroundColor);
    const icon = join(MOBILE, String(options['icon']).replace(/^\.\//, ''));
    expect(existsSync(icon)).toBe(true);
    expect(readFileSync(icon).subarray(0, 8)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
  });
});

describe('Firebase configuration files never enter the public repository', () => {
  it('ignores service configuration files and tracks none of them', () => {
    const gitignore = readFileSync(join(REPOSITORY, '.gitignore'), 'utf8');
    expect(gitignore).toMatch(/^google-services\.json$/m);
    expect(gitignore).toMatch(/^GoogleService-Info\.plist$/m);
    expect(gitignore).toMatch(/^\*service-account\*\.json$/m);

    const tracked = execFileSync('git', ['ls-files'], { cwd: REPOSITORY, encoding: 'utf8' })
      .split('\n')
      .filter(Boolean);
    expect(tracked.filter((path) => /(^|\/)(google-services\.json|GoogleService-Info\.plist|[^/]*service-account[^/]*\.json)$/i.test(path))).toEqual([]);
  });
});
