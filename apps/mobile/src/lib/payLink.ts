import { Linking } from 'react-native';

// expo-web-browser is a NATIVE module: on a binary built before it was added,
// importing it throws. Load it through a guarded require so a stale build falls
// back to the system browser instead of crashing at startup — same lesson as
// netinfo/expo-task-manager (see reference_swift_native_module_crash).
let WebBrowser: typeof import('expo-web-browser') | null = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  WebBrowser = require('expo-web-browser');
} catch {
  WebBrowser = null;
}

/**
 * Open a vendor's / driver's MMG "pay me" link **in-app** — a fast in-app
 * browser (SFSafariViewController on iOS, Custom Tabs on Android) that overlays
 * Swift and returns to it, so the customer never leaves the app to pay. Falls
 * back to the system browser if the in-app-browser module isn't in this native
 * build yet. Never throws.
 */
export async function openPayLink(url?: string | null): Promise<void> {
  if (!url) return;
  try {
    if (WebBrowser?.openBrowserAsync) {
      await WebBrowser.openBrowserAsync(url);
      return;
    }
  } catch {
    // fall through to the system browser
  }
  try {
    await Linking.openURL(url);
  } catch {
    // malformed / unopenable link — nothing more we can do
  }
}
