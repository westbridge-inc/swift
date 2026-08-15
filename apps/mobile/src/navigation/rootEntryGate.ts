export type RootIntent = 'customer' | 'mover' | 'vendor' | 'advertiser';

export type RootEntryGate = 'role-picker' | 'auth' | 'country' | 'selfie' | 'main';

export interface RootEntryState {
  isAuthenticated: boolean;
  wantsAuth: boolean;
  intent: RootIntent | null;
  countryCode: string | null;
  anyPreview: boolean;
  needsSelfie: boolean;
}

/** React Navigation must discard screen-local forms, picked media and pending
 * callbacks whenever an interactive login/logout creates a new principal
 * boundary. Token refresh does not change this generation, so ordinary session
 * continuity keeps its navigation state. */
export function rootNavigatorBoundaryKey(sessionGeneration: number): string {
  return `principal-${sessionGeneration}`;
}

/**
 * The root entry order, kept pure so a fresh install and every existing
 * signed-in path stay characterized. First open is the trio itself: there is
 * deliberately no marketing-onboarding state in this decision.
 */
export function rootEntryGate(state: RootEntryState): RootEntryGate {
  const { isAuthenticated, wantsAuth, intent, countryCode, anyPreview, needsSelfie } = state;

  // Sign-in-first must win over the intent question so the account answers.
  if (wantsAuth && !isAuthenticated) return 'auth';
  if (!intent) return 'role-picker';

  const isEarner = intent === 'mover' || intent === 'vendor' || intent === 'advertiser';
  if (isEarner && !countryCode && !anyPreview) return 'country';
  if (isEarner && !isAuthenticated && !anyPreview) return 'auth';
  if (needsSelfie) return 'selfie';
  return 'main';
}
