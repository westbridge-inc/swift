type AdvertiserExitActions = {
  setIntent: (intent: null) => void;
  logout: () => void;
};

/** Return to the experience picker instead of routing a logged-out user back
 * into advertiser authentication. Intent must change before session teardown. */
export function logoutAndSwitchExperience({ setIntent, logout }: AdvertiserExitActions): void {
  setIntent(null);
  logout();
}
