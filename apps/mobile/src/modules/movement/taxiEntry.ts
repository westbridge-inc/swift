import { requestAuthContinuation } from '../../navigation/authContinuation';

/**
 * [Q4] The taxi door's one way in. Signing in re-keys the root navigator, so a
 * bare promptLogin landed the rider on Home, not back on Taxi, and a pending
 * guardian check-in stayed out of sight until they found Taxi again by hand.
 * The root auth flow's continuation queue resumes Taxi exactly once, after
 * every root gate (OTP, registration, the mandatory selfie) has completed.
 */
export function signInForTaxi(promptLogin: () => void): void {
  requestAuthContinuation({ screen: 'Taxi' }, promptLogin);
}
