import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * Which server each EAS build talks to. The staging server lives at
 * api-staging.swiftgy.com (the owner's swiftgy.com DNS zone). The preview
 * profile once pointed at api-staging.swift.gy, a host that does not serve the
 * platform, so every internal build would have opened onto a dead address.
 */
const eas = JSON.parse(readFileSync(join(process.cwd(), 'eas.json'), 'utf8')) as {
  build: Record<string, { distribution?: string; channel?: string; env?: Record<string, string> }>;
  submit: Record<string, { ios?: { appleTeamId?: string } }>;
};

const STAGING_API = 'https://api-staging.swiftgy.com';

describe('EAS build profiles point at the right server', () => {
  it('preview (internal: the Android APK and ad hoc iPhone builds) uses the staging server', () => {
    expect(eas.build.preview.env?.EXPO_PUBLIC_API_URL).toBe(STAGING_API);
  });

  it('staging (App Store signed, for TestFlight) uses the staging server on its own channel', () => {
    expect(eas.build.staging.distribution).toBe('store');
    expect(eas.build.staging.channel).toBe('staging');
    expect(eas.build.staging.env?.EXPO_PUBLIC_API_URL).toBe(STAGING_API);
    expect(eas.submit.staging.ios?.appleTeamId).toBe(eas.submit.production.ios?.appleTeamId);
  });

  it('the test profiles carry the EAS project id, so push registration works in those builds', () => {
    // app.config.ts sets extra.eas.projectId only when EAS_PROJECT_ID is in the build env; without it
    // push.ts returns early and a test build silently never registers for notifications. The id is
    // public (it ships inside every build as extra.eas.projectId).
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
    expect(eas.build.preview.env?.EAS_PROJECT_ID).toMatch(uuid);
    expect(eas.build.staging.env?.EAS_PROJECT_ID).toBe(eas.build.preview.env?.EAS_PROJECT_ID);
  });

  it('production is not pointed at staging, and no profile uses plain http or a bare IP', () => {
    expect(eas.build.production.env?.EXPO_PUBLIC_API_URL).not.toContain('staging');
    for (const [name, profile] of Object.entries(eas.build)) {
      const url = profile.env?.EXPO_PUBLIC_API_URL;
      if (!url) continue;
      expect({ name, url }).toEqual({ name, url: expect.stringMatching(/^https:\/\/[a-z0-9.-]+\.[a-z]{2,}$/) });
    }
  });
});
