export type RootIntent = 'customer' | 'mover' | 'vendor' | 'advertiser';

export type RootEntryGate = 'role-picker' | 'auth' | 'selfie' | 'main';

export interface RootEntryState {
  isAuthenticated: boolean;
  wantsAuth: boolean;
  intent: RootIntent | null;
  countryCode: string | null;
  anyPreview: boolean;
  needsSelfie: boolean;
}

export interface PreviewFlags {
  moverPreview: boolean;
  vendorSamplePreview: boolean;
}

/**
 * A read-only preview skips country and sign-in ONLY for the stack it
 * previews. The flags outlive their own stack (a guest's "Log out" in the
 * driver preview returns to the welcome with that preview still on), so OR-ing
 * them opened any earner stack signed out — the business one then failed its
 * profile read with a 401 a guest cannot refresh.
 */
export function previewBypassForIntent(intent: RootIntent | null, flags: PreviewFlags): boolean {
  if (intent === 'mover') return flags.moverPreview;
  if (intent === 'vendor') return flags.vendorSamplePreview;
  return false;
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
  const { isAuthenticated, wantsAuth, intent, anyPreview, needsSelfie } = state;

  // Sign-in-first must win over the intent question so the account answers.
  if (wantsAuth && !isAuthenticated) return 'auth';
  if (!intent) return 'role-picker';

  const isEarner = intent === 'mover' || intent === 'vendor' || intent === 'advertiser';
  if (isEarner && !isAuthenticated && !anyPreview) return 'auth';
  if (needsSelfie) return 'selfie';
  return 'main';
}
