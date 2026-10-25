export type RootIntent = 'customer' | 'mover' | 'vendor' | 'advertiser';

export type RootEntryGate = 'role-picker' | 'auth' | 'selfie' | 'hold' | 'main';

export interface RootEntryState {
  isAuthenticated: boolean;
  wantsAuth: boolean;
  intent: RootIntent | null;
  countryCode: string | null;
  anyPreview: boolean;
  needsSelfie: boolean;
  /** An authenticated state carries a user (the hydration law). If it ever
   *  does not, the gate holds [MOB-007]: an earner on the selfie screen, a
   *  customer on the sign-out hold (customers take no photos). */
  hasUser: boolean;
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
  const { isAuthenticated, wantsAuth, intent, anyPreview, needsSelfie, hasUser } = state;

  // Sign-in-first must win over the intent question so the account answers.
  if (wantsAuth && !isAuthenticated) return 'auth';
  if (!intent) return 'role-picker';

  const isEarner = intent === 'mover' || intent === 'vendor' || intent === 'advertiser';
  if (isEarner && !isAuthenticated && !anyPreview) return 'auth';
  // [Owner ruling 16 Oct 2026 — CUSTOMERS TAKE NO PHOTOS] A signed-in customer
  // goes straight in and is never sent to the camera, taxi included (a ride
  // needs only the ID on file). Earners keep this gate, since a mover cannot
  // go online without the photo.
  if (needsSelfie && intent !== 'customer') return 'selfie';
  // [MOB-007] An authenticated state with no user never opens the app for
  // anyone. A customer holds on the sign-out hold (no camera); its "Sign out"
  // is the way back. (needsSelfie is true whenever there is no user.)
  if (needsSelfie && !hasUser) return 'hold';
  return 'main';
}
