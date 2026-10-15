import { Linking, Platform } from 'react-native';
import * as Application from 'expo-application';
import { JOB_OFFERS_CHANNEL } from './jobRingCapability';

/**
 * [RINGER · owner ruling 15 Oct: silent and Do Not Disturb are the partner's
 * choice] Open the system setting that lets job alerts through. Android: the
 * 'Job offers' channel's own page, where the partner can let it override Do
 * Not Disturb (Swift never sets that for them). iOS: Swift's settings, where
 * Notifications > Time Sensitive Notifications lets a job alert through a
 * Focus. Any failure falls back to Swift's settings page.
 */
export async function openJobAlertSettings(): Promise<void> {
  const appPackage = Application.applicationId;
  if (Platform.OS === 'android' && appPackage) {
    try {
      await Linking.sendIntent('android.settings.CHANNEL_NOTIFICATION_SETTINGS', [
        { key: 'android.provider.extra.APP_PACKAGE', value: appPackage },
        { key: 'android.provider.extra.CHANNEL_ID', value: JOB_OFFERS_CHANNEL },
      ]);
      return;
    } catch {
      // An Android that cannot open one channel's page: the app's page.
    }
  }
  await Linking.openSettings().catch(() => undefined);
}

/** The settings row's words, true to what each platform's page offers. */
export function jobAlertSettingsCopy(os: string): { label: string; sub: string } {
  return os === 'android'
    ? { label: 'Let job alerts through Do Not Disturb', sub: 'Opens Job offers: allow it to override Do Not Disturb' }
    : { label: 'Let job alerts through Focus', sub: 'Opens Swift settings: Notifications › Time Sensitive' };
}
