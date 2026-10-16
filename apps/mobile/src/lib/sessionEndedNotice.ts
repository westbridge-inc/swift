import { Alert } from 'react-native';
import { explainSessionEnded } from './accountBlockedAlert';

export const SIGNED_OUT_TITLE = 'You’ve been signed out';
export const SIGNED_OUT_MESSAGE = 'Your sign-in on this phone has ended. Sign in again to carry on.';

/**
 * [Row 3 · "You were signed out"] The server ended this phone's session — its
 * refresh was refused (expired, signed out from another device, revoked) — and
 * the app signed out as a result. Before build 12 that was silent: the person
 * landed on the first screen with no word. Now they are told, with one tap
 * back to sign-in. A suspended or closed account keeps its own explanation
 * (accountBlockedAlert). Called only for a session the app did NOT end itself:
 * a person's own "Sign out" and an account deletion never see this.
 *
 * Never throws: the sign-out has already happened, and a notice that cannot be
 * shown (no native alert in this runtime) must not turn it into an error.
 */
export function noticeSessionEnded(error: unknown, signIn: () => void): void {
  try {
    if (explainSessionEnded(error)) return;
    Alert.alert(SIGNED_OUT_TITLE, SIGNED_OUT_MESSAGE, [
      { text: 'Not now', style: 'cancel' },
      { text: 'Sign in', onPress: signIn },
    ]);
  } catch {
    // Nothing to show it with; the session is already over either way.
  }
}
