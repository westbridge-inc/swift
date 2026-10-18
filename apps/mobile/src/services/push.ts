import { AppState, Linking, Platform } from 'react-native';
import * as Notifications from 'expo-notifications';
import Constants from 'expo-constants';
import axios from 'axios';
import { color } from '@swift/ui';
import { API_URL } from './api';
import { JOB_OFFERS_CHANNEL, JOB_RING_SOUND, hasJobRing, jobAlertsVersion } from './jobRingCapability';
import { getAuthSessionSnapshot } from '../stores/authStore';
import {
  samePrincipalBoundary,
  type AuthSessionSnapshot,
} from '../lib/authSession';

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

let registeredSessionKey: string | null = null;
const registrationFlights = new Map<string, Promise<void>>();
const pushTokensBySession = new Map<string, string>();

function sessionKey(session: AuthSessionSnapshot): string {
  return `${session.generation}:${session.userId}`;
}

function currentPrincipal(expected: AuthSessionSnapshot): AuthSessionSnapshot | null {
  const current = getAuthSessionSnapshot();
  return samePrincipalBoundary(current, expected) ? current : null;
}

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
  const session = getAuthSessionSnapshot();
  if (!session) return;
  const key = sessionKey(session);
  if (registeredSessionKey === key) return;
  const existing = registrationFlights.get(key);
  if (existing) return existing;

  const flight = registerForSession(session, mayPrompt).finally(() => {
    if (registrationFlights.get(key) === flight) registrationFlights.delete(key);
  });
  registrationFlights.set(key, flight);
  return flight;
}

async function registerForSession(session: AuthSessionSnapshot, mayPrompt: boolean): Promise<void> {
  const key = sessionKey(session);
  try {
    if (Platform.OS === 'android') {
      await Notifications.setNotificationChannelAsync('default', {
        name: 'Swift',
        importance: Notifications.AndroidImportance.HIGH,
        vibrationPattern: [0, 250, 250, 250],
        // Android's channel API takes a hex string, so this cannot be a
        // token object — but the VALUE still comes from the token, or the
        // notification LED silently forks the palette.
        lightColor: color.brand[500],
      });
      // [RINGER · owner ruling 15 Oct] Job offers ring on their own channel:
      // the loudest importance, Swift's tone, a strong buzz. Android never
      // lets an app change a channel's sound once it exists, so the channel
      // is created ONLY by a binary that bundles the tone (build 12): this JS
      // reaching an older binary over the air must not create it soundless.
      // Do Not Disturb is the partner's choice (bypassDnd false; they can
      // let it through in the channel's settings, see openJobAlertSettings).
      if (hasJobRing()) {
        await Notifications.setNotificationChannelAsync(JOB_OFFERS_CHANNEL, {
          name: 'Job offers',
          description: 'New orders and job offers that need your answer',
          importance: Notifications.AndroidImportance.MAX,
          sound: JOB_RING_SOUND,
          vibrationPattern: [0, 500, 250, 500, 250, 500],
          enableVibrate: true,
          bypassDnd: false,
          lightColor: color.brand[500],
        });
      }
    }

    const projectId = (Constants.expoConfig?.extra as { eas?: { projectId?: string } } | undefined)?.eas?.projectId;
    if (!projectId) return;

    const permission = await Notifications.getPermissionsAsync();
    let status = permission.status;
    if (status !== 'granted') {
      if (!mayPrompt) return;
      status = (await Notifications.requestPermissionsAsync()).status;
    }
    if (status !== 'granted') return;

    const token = (await Notifications.getExpoPushTokenAsync({ projectId })).data;
    let current = currentPrincipal(session);
    if (!current) return;

    const send = (accessToken: string) =>
      axios.post(
        `${API_URL}/api/v1/customer/notifications/devices`,
        // [RINGER] alertsVersion tells the server whether THIS binary has
        // the job ring (1, build 12) or not (0): only a binary that has it is
        // sent the job_offers channel, the tone and time-sensitive.
        { token, platform: Platform.OS === 'ios' ? 'ios' : 'android', alertsVersion: jobAlertsVersion() },
        {
          timeout: 10000,
          headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        },
      );

    try {
      await send(current.accessToken);
    } catch (error) {
      // A token may rotate between permission/token lookup and this POST. Retry
      // once only for the same principal, with the newly current access token.
      const latest = currentPrincipal(session);
      if (!axios.isAxiosError(error) || error.response?.status !== 401 ||
          !latest || latest.accessToken === current.accessToken) {
        throw error;
      }
      current = latest;
      await send(current.accessToken);
    }

    // Keep the exact token even if logout won while the POST was in flight;
    // its logout handoff awaits this flight and deactivates the A-scoped row.
    pushTokensBySession.set(key, token);
    if (currentPrincipal(session)) registeredSessionKey = key;
  } catch {
    // Push is an enhancement — never surface an error for it.
  }
}

/**
 * Resolve the device token owned by the captured logout session. The caller
 * sends it to POST /auth/logout so token deactivation + session revocation are
 * one server transaction. This never reads a newer account's credentials.
 */
export async function preparePushTokenForLogout(session: AuthSessionSnapshot): Promise<string | null> {
  const key = sessionKey(session);
  try {
    await registrationFlights.get(key)?.catch(() => undefined);
    const known = pushTokensBySession.get(key);
    if (known) return known;

    const projectId = (Constants.expoConfig?.extra as { eas?: { projectId?: string } } | undefined)?.eas?.projectId;
    if (!projectId) return null;
    return (await Notifications.getExpoPushTokenAsync({ projectId })).data;
  } catch {
    return null;
  } finally {
    pushTokensBySession.delete(key);
    if (registeredSessionKey === key) registeredSessionKey = null;
  }
}

// ---------------------------------------------------------------------------
// [STORE-ALERT 18 Oct 2026] An earner's phone must be able to ring.
//
// iOS starts every install "undetermined", and the only OS prompt in the app
// was the one-time priming card at three moments (an order placed, a driver
// application, a store created IN the app). A store owner who signed in on an
// iPhone was never asked, held no push token, and a new order rang nothing:
// only the backup SMS arrived. These helpers let the earner dashboards ask
// (services/notification-priming maybePrimeEarnerNotifications), show the
// state (components/PushOffStrip) and re-register when the person comes back
// from Settings (installPushForegroundRetry).
// ---------------------------------------------------------------------------

/** What turning push on takes on this phone: nothing, the OS prompt, or Settings. */
export type PushPermission = 'granted' | 'ask' | 'settings';

export async function pushPermission(): Promise<PushPermission> {
  try {
    const permission = await Notifications.getPermissionsAsync();
    if (permission.status === 'granted') return 'granted';
    // iOS asks once: after that canAskAgain is false and only Settings can turn
    // it on. Android 13+ may ask again after a first refusal.
    return permission.canAskAgain === false ? 'settings' : 'ask';
  } catch {
    return 'ask';
  }
}

/** The earner's "Turn on": the OS prompt while it can still be shown (and the
 *  registration that follows a yes), otherwise this app's page in Settings. */
export async function turnOnPush(): Promise<PushPermission> {
  const now = await pushPermission();
  if (now === 'settings') {
    await Linking.openSettings().catch(() => undefined);
    return now;
  }
  if (now === 'ask') await registerDeviceForPush();
  return pushPermission();
}

/** Re-run the silent registration whenever the app comes to the foreground:
 *  someone who turned notifications on in Settings registers the moment they
 *  return, not at the next cold start. register() no-ops once this session's
 *  token is on the server. */
export function installPushForegroundRetry(): () => void {
  const subscription = AppState.addEventListener('change', (state) => {
    if (state === 'active') void registerIfGranted();
  });
  return () => subscription.remove();
}
