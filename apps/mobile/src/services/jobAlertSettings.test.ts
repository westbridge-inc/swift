import { beforeEach, describe, expect, it, vi } from 'vitest';

const rn = vi.hoisted(() => ({
  Platform: { OS: 'android' as string },
  Linking: { sendIntent: vi.fn(async () => undefined), openSettings: vi.fn(async () => undefined) },
}));
vi.mock('react-native', () => rn);
vi.mock('expo-application', () => ({ applicationId: 'gy.swift.app' }));
vi.mock('./jobRingCapability', () => ({ JOB_OFFERS_CHANNEL: 'job_offers' }));

import { jobAlertSettingsCopy, openJobAlertSettings } from './jobAlertSettings';

// [RINGER · owner: Do Not Disturb is the partner's choice] The helper only
// OPENS the setting; the partner decides.
beforeEach(() => {
  vi.clearAllMocks();
  rn.Platform.OS = 'android';
});

describe('openJobAlertSettings', () => {
  it('Android: opens the Job offers channel page of this app', async () => {
    await openJobAlertSettings();
    expect(rn.Linking.sendIntent).toHaveBeenCalledWith('android.settings.CHANNEL_NOTIFICATION_SETTINGS', [
      { key: 'android.provider.extra.APP_PACKAGE', value: 'gy.swift.app' },
      { key: 'android.provider.extra.CHANNEL_ID', value: 'job_offers' },
    ]);
    expect(rn.Linking.openSettings).not.toHaveBeenCalled();
  });

  it('Android that cannot open a channel page, and iOS: Swift settings', async () => {
    rn.Linking.sendIntent.mockRejectedValueOnce(new Error('no activity'));
    await openJobAlertSettings();
    expect(rn.Linking.openSettings).toHaveBeenCalledTimes(1);
    rn.Platform.OS = 'ios';
    await openJobAlertSettings();
    expect(rn.Linking.sendIntent).toHaveBeenCalledTimes(1);
    expect(rn.Linking.openSettings).toHaveBeenCalledTimes(2);
  });

  it('names what each platform page offers', () => {
    expect(jobAlertSettingsCopy('android').label).toBe('Let job alerts through Do Not Disturb');
    expect(jobAlertSettingsCopy('ios').label).toBe('Let job alerts through Focus');
  });
});
