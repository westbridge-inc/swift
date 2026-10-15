import { afterEach, describe, expect, it, vi } from 'vitest';
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
