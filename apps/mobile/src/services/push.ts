import { Platform } from 'react-native';
import * as Notifications from 'expo-notifications';
import Constants from 'expo-constants';
import axios from 'axios';
import { color } from '@swift/ui';
import { API_URL } from './api';
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
        { token, platform: Platform.OS === 'ios' ? 'ios' : 'android' },
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
