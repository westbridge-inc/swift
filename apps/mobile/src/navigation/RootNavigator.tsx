/** @jsxImportSource react */
import React from 'react';
import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { useAuthStore } from '../stores/authStore';
import { LegalAcceptanceModal } from '../components/LegalAcceptanceModal';
import { useMoverPreview } from '../stores/moverPreview';
import { useVendorPreview } from '../stores/vendorPreview';
import { useCustomerCountry } from '../hooks/useCustomerCountry';
import { installPushForegroundRetry, registerIfGranted } from '../services/push';
import { RolePickerScreen } from '../screens/auth/RolePickerScreen';
import { SelfieCaptureScreen } from '../screens/auth/SelfieCaptureScreen';
import { SessionHoldScreen } from '../screens/auth/SessionHoldScreen';
import { QrOutcomeScreen } from '../screens/QrOutcomeScreen';
import { OpsAlertsScreen } from '../screens/OpsAlertsScreen';
import { OwnedSafetyPanel } from '../modules/safety/OwnedSafetyPanel';
import { AuthStack } from './AuthStack';
import { CustomerStack } from './CustomerStack';
import { MoverStack } from '../modules/mover/MoverStack';
import { VendorStack } from '../modules/vendor/VendorStack';
import { AdvertiserStack } from '../modules/advertiser/AdvertiserStack';
import { navigationRef, safeNavigate } from './navigationRef';
import { installNotificationTapRouter, flushPendingNavigation, settleTapAfterSignIn } from '../services/notification-router';
import { installDeepLinkHandler, flushPendingDeepLink } from '../services/deep-links';
import { ensureFirstLaunchClaim, flushAttributedDestination } from '../services/attribution';
import { previewBypassForIntent, rootEntryGate, rootNavigatorBoundaryKey } from './rootEntryGate';
import {
  discardAuthContinuation,
  flushAuthContinuation,
  rootRouteForAuthContinuation,
} from './authContinuation';

const Stack = createNativeStackNavigator();

// One "Swift" app. The entry "How will you use Swift?" screen sets `intent`,
// which picks the experience:
//   customer → consumer super-app (browse as a guest; sign in at checkout)
//   mover    → driver/rider earner app (must sign in + onboard)
//   vendor   → store/restaurant dashboard (must sign in + onboard)
function mainForIntent(intent?: string | null) {
  switch (intent) {
    case 'mover':
      return MoverStack;
    case 'vendor':
      return VendorStack;
    case 'advertiser':
      return AdvertiserStack;
    default:
      return CustomerStack;
  }
}

export function RootNavigator() {
  const { isAuthenticated, wantsAuth, intent, countryCode, user, sessionGeneration } = useAuthStore();
  // V1 has one launch market. This keeps the persisted market pinned to Guyana
  // rather than asking people to choose a country Swift does not serve yet.
  useCustomerCountry();

  // Push registration follows the session — but NEVER prompts at boot
  // [first-open SO-5]: silent for already-granted users; the ask itself
  // happens at in-context priming moments (config-gated no-op until the EAS
  // project id ships — see services/push.ts).
  React.useEffect(() => {
    if (isAuthenticated) void registerIfGranted();
  }, [isAuthenticated, sessionGeneration]);

  // [STORE-ALERT] ...and again whenever the app returns to the foreground, so
  // turning notifications on in Settings registers this phone at once.
  React.useEffect(() => {
    if (!isAuthenticated) return undefined;
    return installPushForegroundRetry();
  }, [isAuthenticated, sessionGeneration]);

  // The tap-router [first-open 2.4]: every notification tap lands on its
  // exact screen — cold starts flush via onReady below.
  React.useEffect(() => installNotificationTapRouter(), []);

  // QR deep links (/store/{slug}, /s/{code}) + the one-time install claim
  // [qr spec Part 6]: same queue-and-flush contract as the tap-router.
  React.useEffect(() => {
    ensureFirstLaunchClaim();
    const uninstall = installDeepLinkHandler();
    // Also covers an effect reinstall after the container became ready.
    if (navigationRef.isReady()) flushPendingDeepLink();
    return uninstall;
  }, []);

  // Earners (mover/vendor) and advertisers must be signed in before their
  // stack. Customers browse freely and only authenticate when an action
  // (checkout) asks via promptLogin() → wantsAuth.
  // PREVIEW (earner R3 / vendor R4): a prospective driver ("Preview the driver
  // app") or business ("Preview a business") reaches the REAL stack WITHOUT a
  // country, sign-in, or selfie — read-only sample data. The vendor SAMPLE
  // preview is `previewType != null` (a set type), NOT the legacy pending-vendor
  // peek (previewType null), which stays signed-in.
  const moverPreview = useMoverPreview((s) => s.preview);
  const vendorSamplePreview = useVendorPreview((s) => s.previewType) != null;
  // Each preview opens only its own stack (see previewBypassForIntent).
  const anyPreview = previewBypassForIntent(intent, { moverPreview, vendorSamplePreview });
  // Profile selfie (master plan §3): a signed-in EARNER account (mover,
  // business, advertiser) carries a camera-captured profile photo before using
  // the app. [Owner ruling 16 Oct 2026] Customers take no photos, taxi
  // included: the API enforces the photo only on going online.
  // [MOB-007] Not conditional on a user being present: the store's hydration
  // law guarantees an authenticated state carries a user, and if it ever did
  // not, the gate holds (earner: selfie; customer: the sign-out hold) rather
  // than opening the stack.
  const needsSelfie = isAuthenticated && !user?.selfieCapturedAt;
  const Main = mainForIntent(intent);
  const entryGate = rootEntryGate({ isAuthenticated, wantsAuth, intent, countryCode, anyPreview, needsSelfie, hasUser: !!user });

  const resumeAuthContinuation = React.useCallback(() => {
    flushAuthContinuation(
      { isAuthenticated, entryGate, intent },
      (destination) => {
        const route = rootRouteForAuthContinuation(destination);
        return safeNavigate(route.screen, route.params);
      },
    );
  }, [entryGate, intent, isAuthenticated]);

  React.useEffect(() => {
    // Cancel and logout are terminal for an unfinished guest continuation.
    // This also prevents an abandoned provider intent from surprising a later
    // account on a shared device.
    if (!isAuthenticated && !wantsAuth) {
      discardAuthContinuation();
      return;
    }
    if (!isAuthenticated || entryGate !== 'main') return;

    // The first post-commit attempt normally delivers. Retain one bounded
    // retry for native navigation containers that become ready a frame later.
    const firstAttempt = setTimeout(resumeAuthContinuation, 0);
    const readyRetry = setTimeout(resumeAuthContinuation, 250);
    return () => {
      clearTimeout(firstAttempt);
      clearTimeout(readyRetry);
    };
  }, [entryGate, isAuthenticated, resumeAuthContinuation, sessionGeneration, wantsAuth]);

  // [row 205 · DS256 F2] A notification tapped while signed out opened sign-in
  // and waits there. It lands once the same account is through every root
  // gate; a different account or a cancelled sign-in drops it. Same post-commit
  // attempt + one ready retry as the auth continuation above.
  React.useEffect(() => {
    const settle = () => { settleTapAfterSignIn({ isAuthenticated, wantsAuth, entryGate }); };
    if (!isAuthenticated || entryGate !== 'main') { settle(); return; }
    const firstAttempt = setTimeout(settle, 0);
    const readyRetry = setTimeout(settle, 250);
    return () => {
      clearTimeout(firstAttempt);
      clearTimeout(readyRetry);
    };
  }, [entryGate, isAuthenticated, sessionGeneration, wantsAuth]);

  return (
    <>
    <NavigationContainer
      ref={navigationRef}
      onReady={() => {
        flushPendingNavigation();
        flushPendingDeepLink();
        flushAttributedDestination();
        resumeAuthContinuation();
      }}
    >
      <Stack.Navigator
        key={rootNavigatorBoundaryKey(sessionGeneration)}
        screenOptions={{ headerShown: false }}
      >
        {entryGate === 'auth' ? (
          // "Already have an account? Sign in" from first-open (intent null —
          // after OTP the ACCOUNT routes, the trio is never asked) and the
          // guest checkout prompt both land here. Placed before the intent
          // question so sign-in-first needs no role answer.
          <Stack.Screen name="Auth" component={AuthStack} />
        ) : entryGate === 'role-picker' ? (
          // Fresh install: the trio IS the welcome. Marketing onboarding
          // carousels are explicitly banned by first-open spec 2.1.
          <Stack.Screen name="RolePicker" component={RolePickerScreen} />
        ) : entryGate === 'selfie' ? (
          <Stack.Screen name="Selfie" component={SelfieCaptureScreen} />
        ) : entryGate === 'hold' ? (
          <Stack.Screen name="SessionHold" component={SessionHoldScreen} />
        ) : (
          <Stack.Screen name="Main" component={Main} />
        )}
        {/* A scanned store is public, regardless of the selected role or
            first-open gate. Explicit nested navigation opens its menu while
            keeping the visitor's existing role and auth state intact. */}
        <Stack.Screen
          name="Storefront"
          component={CustomerStack}
          navigationKey={wantsAuth && !isAuthenticated ? 'store-auth' : 'store-browse'}
        />
        <Stack.Screen name="QrOutcome" component={QrOutcomeScreen} />
        {/* [DRILL-STORM] A responder's pages, reached from the page's own push in any app mode. */}
        <Stack.Screen name="OpsAlerts" component={OpsAlertsScreen} />
      </Stack.Navigator>
      {/* [R26 · research G2] a material change to the Terms is accepted with a fresh tick (build 12) */}
      <LegalAcceptanceModal />
    </NavigationContainer>
    <OwnedSafetyPanel />
    </>
  );
}
