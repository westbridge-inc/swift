import { Platform } from 'react-native';
import * as Notifications from 'expo-notifications';
import Constants from 'expo-constants';
import { api } from './api';

// Foreground pushes still show as banners — an order update matters MORE
// while the customer is watching the app.
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

let registered = false;

/**
 * Registers this device for push after login. Config-gated like every other
 * provider: without an EAS project id (EAS_PROJECT_ID at build time) Expo
 * can't mint push tokens, so this quietly no-ops until the credential ships —
 * the server half (device registry + exp.host sender) is already live.
 * Best-effort by design: push failing must never affect auth.
 */
export async function registerDeviceForPush(): Promise<void> {
  await register(true);
}

/** Session-start path [first-open SO-5]: registers ONLY when permission is
 *  already granted — never prompts at boot. The prompt itself belongs to the
 *  in-context priming moments (services/notification-priming). */
export async function registerIfGranted(): Promise<void> {
  await register(false);
}

async function register(mayPrompt: boolean): Promise<void> {
  if (registered) return;
  try {
    if (Platform.OS === 'android') {
      await Notifications.setNotificationChannelAsync('default', {
        name: 'Swift',
        importance: Notifications.AndroidImportance.HIGH,
        vibrationPattern: [0, 250, 250, 250],
        lightColor: '#803B3B',
      });
    }

    const projectId = (Constants.expoConfig?.extra as { eas?: { projectId?: string } } | undefined)?.eas?.projectId;
    if (!projectId) return;

    const current = await Notifications.getPermissionsAsync();
    let status = current.status;
    if (status !== 'granted') {
      if (!mayPrompt) return;
      status = (await Notifications.requestPermissionsAsync()).status;
    }
    if (status !== 'granted') return;

    const token = (await Notifications.getExpoPushTokenAsync({ projectId })).data;
    await api.post('/customer/notifications/devices', {
      token,
      platform: Platform.OS === 'ios' ? 'ios' : 'android',
    });
    registered = true;
  } catch {
    // Push is an enhancement — never surface an error for it.
  }
}

/** Deactivate this device's token on logout (server keeps it inactive). */
export async function unregisterDeviceForPush(): Promise<void> {
  try {
    const projectId = (Constants.expoConfig?.extra as { eas?: { projectId?: string } } | undefined)?.eas?.projectId;
    if (!projectId || !registered) return;
    const token = (await Notifications.getExpoPushTokenAsync({ projectId })).data;
    await api.delete('/customer/notifications/devices', { data: { token } });
    registered = false;
  } catch {
    // best-effort
  }
}
