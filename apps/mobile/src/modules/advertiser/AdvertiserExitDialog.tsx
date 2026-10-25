import { useCallback } from 'react';
import { useLogoutConfirm, type LogoutConfirm } from '../../kit';
import { useAuthStore } from '../../stores/authStore';
import { logoutAndSwitchExperience } from './advertiserExit';

/** The advertiser's exit is the shared log-out ask in its own words: it names
 *  where the person lands (the experience picker) and what stays saved. The
 *  confirm hands over the store's logout(); advertiserExit clears the intent
 *  before it, so a logged-out user is never routed back into advertiser auth. */
export function useAdvertiserExitDialog(): LogoutConfirm {
  const setIntent = useAuthStore((state) => state.setIntent);
  const onLogout = useCallback(
    (logout: () => void) => logoutAndSwitchExperience({ setIntent, logout }),
    [setIntent],
  );
  return useLogoutConfirm({
    title: 'Switch away from advertising?',
    body: "You'll log out on this device and return to Swift's experience picker. Your campaigns, team, and billing history stay saved.",
    confirmLabel: 'Log out and switch experience',
    confirmIcon: 'log-out',
    cancelLabel: 'Stay in advertising',
    onLogout,
  });
}
