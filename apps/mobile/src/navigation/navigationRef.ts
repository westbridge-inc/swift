import { createNavigationContainerRef } from '@react-navigation/native';

// The one imperative handle into navigation — owned by RootNavigator's
// container, consumed by the notification tap-router (and nothing else
// without a reason). Navigating before the container mounts is a no-op by
// design; callers queue and flush on ready.
export const navigationRef = createNavigationContainerRef<Record<string, object | undefined>>();

export function safeNavigate(screen: string, params?: Record<string, unknown>): boolean {
  try {
    if (!navigationRef.isReady()) return false;
    // [UI-SWEEP U10] `pop: true`: a destination already in the stack is gone
    // BACK to (React Navigation 7's plain navigate pushes a second copy — a
    // second business home doubled the new-order alarm). One not in the stack
    // is pushed as before.
    (navigationRef.navigate as (s: string, p?: Record<string, unknown>, o?: { pop?: boolean }) => void)(screen, params, { pop: true });
    return true;
  } catch {
    // A screen the current stack doesn't mount (e.g. an earner tapping a
    // customer push) must open the app normally, never crash it.
    return false;
  }
}
