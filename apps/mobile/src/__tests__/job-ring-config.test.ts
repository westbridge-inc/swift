import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// [RINGER] What build 12 carries for the job ring, and what it must not:
// the tone in both native bundles, the iOS time-sensitive entitlement (never
// critical alerts, owner ruling), expo-audio for playback only (no microphone
// purpose string, no RECORD_AUDIO, no background audio).
// ---------------------------------------------------------------------------

const MOBILE = process.cwd();

type AppConfig = {
  ios: { entitlements?: Record<string, unknown>; infoPlist?: Record<string, unknown> };
  android: { blockedPermissions?: string[]; permissions?: string[] };
  plugins: unknown[];
};

async function loadConfig(): Promise<AppConfig> {
  vi.stubEnv('ANDROID_GOOGLE_MAPS_API_KEY', 'test-maps-key');
  return (await import('../../app.config')).default as unknown as AppConfig;
}

function pluginOptions(config: AppConfig, name: string): Record<string, unknown> {
  const plugin = config.plugins.find(
    (entry): entry is [string, Record<string, unknown>] => Array.isArray(entry) && entry[0] === name,
  );
  expect(plugin, name).toBeDefined();
  return plugin![1];
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('build 12 job ring configuration', () => {
  it('bundles the tone for iOS sounds and Android res/raw', async () => {
    const options = pluginOptions(await loadConfig(), 'expo-notifications');
    expect(options['sounds']).toEqual(['./assets/sounds/swift_job_ring.wav']);
    expect(existsSync(join(MOBILE, 'assets/sounds/swift_job_ring.wav'))).toBe(true);
  });

  it('asks iOS for time-sensitive notifications, never critical alerts', async () => {
    const config = await loadConfig();
    expect(config.ios.entitlements).toMatchObject({ 'com.apple.developer.usernotifications.time-sensitive': true });
    expect(config.ios.entitlements).not.toHaveProperty('com.apple.developer.usernotifications.critical-alerts');
  });

  it('uses expo-audio for playback only: no microphone, no recording, no background audio', async () => {
    const config = await loadConfig();
    expect(pluginOptions(config, 'expo-audio')).toEqual({
      microphonePermission: false,
      recordAudioAndroid: false,
      enableBackgroundPlayback: false,
      enableBackgroundRecording: false,
    });
    expect(config.ios.infoPlist).not.toHaveProperty('NSMicrophoneUsageDescription');
    expect(config.ios.infoPlist?.['UIBackgroundModes']).not.toContain('audio');
    expect(config.android.blockedPermissions).toContain('android.permission.RECORD_AUDIO');
    expect(config.android.permissions ?? []).not.toContain('RECORD_AUDIO');
    const pkg = JSON.parse(readFileSync(join(MOBILE, 'package.json'), 'utf8')) as { dependencies: Record<string, string> };
    expect(pkg.dependencies['expo-audio']).toMatch(/^~56\./);
  });
});

// The real Expo plugin pipeline in introspect mode (in memory, writes
// nothing), as android-maps-key-manifest.test.ts runs it: what an EAS build
// of this config puts in Info.plist, the entitlements and AndroidManifest.
const COMPILE = `
const { createRequire } = require('node:module');
const path = require('node:path');
const root = process.cwd();
const fromExpo = createRequire(createRequire(path.join(root, 'package.json')).resolve('expo/package.json'));
const { getPrebuildConfigAsync } = fromExpo('@expo/prebuild-config');
const { compileModsAsync } = fromExpo('@expo/config-plugins');
(async () => {
  const { exp } = await getPrebuildConfigAsync(root, { platforms: ['ios', 'android'] });
  const out = await compileModsAsync(exp, { projectRoot: root, introspect: true, platforms: ['ios', 'android'], assertMissingModProviders: false });
  const r = out._internal.modResults;
  const manifest = r.android.manifest.manifest;
  process.stdout.write('\\n@@OUT@@' + JSON.stringify({
    plist: r.ios.infoPlist,
    entitlements: r.ios.entitlements,
    permissions: (manifest['uses-permission'] || []).map((p) => ({ name: p.$['android:name'], node: p.$['tools:node'] })),
    services: (manifest.application[0].service || []).map((s) => s.$['android:name']),
  }));
})().catch((e) => { console.error(e); process.exit(1); });
`;

describe('what an EAS build of this config really carries', () => {
  it('time-sensitive in the entitlements; no microphone, no background audio, RECORD_AUDIO removed', () => {
    const raw = execFileSync(process.execPath, ['-e', COMPILE], {
      cwd: MOBILE,
      env: { ...process.env, ANDROID_GOOGLE_MAPS_API_KEY: 'test-maps-key', EAS_BUILD_PLATFORM: '' },
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const out = JSON.parse(raw.slice(raw.lastIndexOf('@@OUT@@') + 7)) as {
      plist: Record<string, unknown>;
      entitlements: Record<string, unknown>;
      permissions: Array<{ name: string; node?: string }>;
      services: string[];
    };
    expect(out.entitlements['com.apple.developer.usernotifications.time-sensitive']).toBe(true);
    expect(out.entitlements).not.toHaveProperty('com.apple.developer.usernotifications.critical-alerts');
    expect(out.plist).not.toHaveProperty('NSMicrophoneUsageDescription');
    expect(out.plist['UIBackgroundModes']).not.toContain('audio');
    expect(out.permissions).toContainEqual({ name: 'android.permission.RECORD_AUDIO', node: 'remove' });
    expect(out.permissions.map((p) => p.name)).not.toContain('android.permission.FOREGROUND_SERVICE_MEDIA_PLAYBACK');
    expect(out.services.filter((name) => /audio/i.test(name))).toEqual([]);
  }, 120_000);
});

