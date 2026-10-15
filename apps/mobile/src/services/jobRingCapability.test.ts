import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { JOB_OFFERS_CHANNEL, JOB_RING_SOUND, RINGER_ALERTS_VERSION, hasJobRing, jobAlertsVersion } from './jobRingCapability';

// [RINGER] The job ring is a property of the NATIVE binary (build 12), never
// of the JS bundle, which can reach builds 9-11 over the air.
describe('jobRingCapability', () => {
  it('build 12 (the ExpoAudio native module is linked): has the ring, reports alertsVersion 1', () => {
    const lookup = vi.fn(() => ({}));
    expect(hasJobRing(lookup)).toBe(true);
    expect(jobAlertsVersion(lookup)).toBe(1);
    expect(lookup).toHaveBeenCalledWith('ExpoAudio');
  });

  it('builds 9-11 (no native module), or no expo to ask: no ring, alertsVersion 0', () => {
    expect([hasJobRing(() => null), jobAlertsVersion(() => null)]).toEqual([false, 0]);
    expect([hasJobRing(() => undefined), jobAlertsVersion(() => undefined)]).toEqual([false, 0]);
    expect([hasJobRing(null), jobAlertsVersion(null)]).toEqual([false, 0]);
  });

  it('the app asks expo itself, lazily, and never loads expo-audio to find out', () => {
    const source = readFileSync(join(process.cwd(), 'src/services/jobRingCapability.ts'), 'utf8');
    expect(source).toContain("require('expo') as { requireOptionalNativeModule?: NativeModuleLookup }");
    expect(source).toContain("lookup('ExpoAudio') != null");
    expect(source).not.toMatch(/^import .* from 'expo'/m);
    expect(source).not.toContain("'expo-audio'");
  });
});

describe('the contract with the API (apps/api alert-class.ts pins the same three literals in job-ring-push.test.ts)', () => {
  it('channel, tone file and alertsVersion', () => {
    expect([JOB_OFFERS_CHANNEL, JOB_RING_SOUND, RINGER_ALERTS_VERSION]).toEqual(['job_offers', 'swift_job_ring.wav', 1]);
  });
});
