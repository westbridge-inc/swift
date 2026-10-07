import { Alert, Linking } from 'react-native';
import { accountBlockedOf, accountSupportMailto } from './accountBlocked';

/**
 * [NO-DEAD-ENDS] Swift suspended or closed this account mid-session and the
 * token refresh ended the session. Say so, with the one door that needs no
 * session, instead of dropping the person at the welcome screen without a
 * word. Any other ended session (expired, revoked) stays the quiet sign-out it
 * was. Only React Native's own Alert and Linking: the API client imports this.
 */
export function explainSessionEnded(error: unknown): boolean {
  const blocked = accountBlockedOf(error);
  if (!blocked) return false;
  Alert.alert('You’ve been signed out', blocked.message, [
    {
      text: 'Email support',
      onPress: () => {
        Linking.openURL(accountSupportMailto(blocked)).catch(() => {
          Alert.alert('Couldn’t open your mail app', `Write to ${blocked.supportEmail}.`);
        });
      },
    },
    { text: 'OK', style: 'cancel' },
  ]);
  return true;
}
