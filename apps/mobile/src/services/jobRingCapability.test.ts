import { beforeEach, describe, expect, it, vi } from 'vitest';

// [RINGER] The job ring is a property of the NATIVE binary (build 12), never
// of the JS bundle, which can reach builds 9-11 over the air.
const expo = vi.hoisted(() => ({ requireOptionalNativeModule: vi.fn() }));
vi.mock('expo', () => expo);

import { JOB_OFFERS_CHANNEL, JOB_RING_SOUND, RINGER_ALERTS_VERSION, hasJobRing, jobAlertsVersion } from './jobRingCapability';

beforeEach(() => expo.requireOptionalNativeModule.mockReset());

describe('jobRingCapability', () => {
  it('build 12 (the ExpoAudio native module is linked): has the ring, reports alertsVersion 1', () => {
    expo.requireOptionalNativeModule.mockReturnValue({});
    expect(hasJobRing()).toBe(true);
    expect(jobAlertsVersion()).toBe(1);
    expect(expo.requireOptionalNativeModule).toHaveBeenCalledWith('ExpoAudio');
  });

  it('builds 9-11 (no native module): no ring, alertsVersion 0', () => {
    expo.requireOptionalNativeModule.mockReturnValue(null);
    expect([hasJobRing(), jobAlertsVersion()]).toEqual([false, 0]);
    expo.requireOptionalNativeModule.mockReturnValue(undefined);
    expect([hasJobRing(), jobAlertsVersion()]).toEqual([false, 0]);
  });
});

describe('the contract with the API (apps/api alert-class.ts pins the same three literals in job-ring-push.test.ts)', () => {
  it('channel, tone file and alertsVersion', () => {
    expect([JOB_OFFERS_CHANNEL, JOB_RING_SOUND, RINGER_ALERTS_VERSION]).toEqual(['job_offers', 'swift_job_ring.wav', 1]);
  });
});

