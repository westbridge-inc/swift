import { Alert, Linking } from 'react-native';
import { accountBlockedOf, accountSupportMailto } from './accountBlocked';

/** Open a mail draft to support; a phone with no mail app is told where to write. */
export function openSupportMail(mailto: string, supportEmail: string): void {
  Linking.openURL(mailto).catch(() => {
    Alert.alert('Couldn’t open your mail app', `Write to ${supportEmail}.`);
  });
}

/**
 * [NO-DEAD-ENDS] Swift suspended or closed this account mid-session and the
 * token refresh ended the session. Say so, with the one door that needs no
 * session, instead of dropping the person at the welcome screen without a
 * word. Any other ended session (expired, revoked) stays the quiet sign-out it
 * was. Only React Native's own Alert and Linking (no kit, no animation
 * library): the API client and the code screen import this, and so do the
 * web suites that mount those screens.
 */
export function explainSessionEnded(error: unknown): boolean {
  const blocked = accountBlockedOf(error);
  if (!blocked) return false;
  Alert.alert('You’ve been signed out', blocked.message, [
    {
      text: 'Email support',
      onPress: () => openSupportMail(accountSupportMailto(blocked), blocked.supportEmail),
    },
    { text: 'OK', style: 'cancel' },
  ]);
  return true;
}
