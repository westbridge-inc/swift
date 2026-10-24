import { Alert } from 'react-native';

export const DEMO_ENDED_TITLE = 'This demo has ended';
export const DEMO_ENDED_MESSAGE = 'The demo account’s session is over, so it has been signed out on this phone. You can sign in with your own phone number.';

/**
 * [Row 353 · STA-1 DL-9] The store-review demo answers every request with
 * 410 REVIEW_SESSION_CLOSED once its session is over. Only an account in the
 * review fiction can ever receive it: a real customer's session never does.
 */
export function isReviewSessionClosed(error: unknown): boolean {
  const response = (error as { response?: { status?: unknown; data?: { error?: { code?: unknown } } } } | null)?.response;
  return response?.status === 410 && response.data?.error?.code === 'REVIEW_SESSION_CLOSED';
}

/**
 * Said once, when the app has just signed the demo account out because of it:
 * a clear sentence and the sign-in screen behind it, never a crash or a blank
 * screen. Never throws: the sign-out has already happened.
 */
export function explainDemoEnded(): void {
  try {
    Alert.alert(DEMO_ENDED_TITLE, DEMO_ENDED_MESSAGE, [{ text: 'OK' }]);
  } catch {
    // Nothing to show it with; the demo session is already signed out.
  }
}
