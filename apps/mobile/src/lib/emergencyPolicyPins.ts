// [AUD-G7-023 · board row 202] The public keys this app trusts to sign the
// emergency-number policy (GET /public/emergency-policy → `envelope`).
//
// A served emergency number is trusted ONLY when its Ed25519 signature verifies
// under one of these pins (lib/emergencyPolicySignature.ts). Anything else — no
// envelope, an unknown key, a bad signature, another market, an expired policy —
// is not a policy: the app keeps the last policy that verified, or dials its
// bundled numbers (Guyana 911 / 912 / 913). It never dials an unverified number.
//
// A pin is PUBLIC (not a secret): the key id and the 32-byte Ed25519 public key
// in lowercase hex, exactly as the API prints them at boot ("public key to pin in
// the app"). The private half is generated on each server by
// deploy/owner/emergency-policy-key.command and never leaves it.
//
// Pinned: exactly two keys, each made on its own server.
//   1. PRODUCTION — the key the production API signs with.
//   2. STAGING — pinned because App Review tests this app against the staging API
//      until the DNS cutover (until then the app's API address is served by
//      staging). Without this pin, review phones would get no verified policy and
//      fall back to the bundled numbers.
//
// RULE: drop the STAGING pin in the first app build after the DNS cutover. After
// the cutover staging serves no real phone, and a staging-server key compromise
// must not stay able to sign emergency numbers that production phones trust.
// The pin tests (emergencyPolicySignature.test.ts "shipped pins") fix the count,
// so that build changes the count with the pin, in a reviewed PR.
//
// Rotation: pin the NEW key here and ship that app build BEFORE the server signs
// with it; remove the old pin in a later build. Never fetch a pin from the server.

export interface EmergencyPolicyPin {
  /** The API's key id, e.g. `ep1-` + 16 hex. */
  readonly kid: string;
  /** The Ed25519 public key: 64 lowercase hex characters. */
  readonly ed25519: string;
}

export const EMERGENCY_POLICY_PINS: readonly EmergencyPolicyPin[] = Object.freeze([
  // Production.
  Object.freeze({ kid: 'ep1-5ebb7d4699ee0f78', ed25519: '3c12e89d0280eab20474fd7443a046375d944b480547011f5d530a101035ad24' }),
  // Staging (App Review until the DNS cutover). Drop in the first build after the cutover.
  Object.freeze({ kid: 'ep1-4a6de1b1e5c92f48', ed25519: '2f1862c85b3b57b24987b4ee612531b4bd32804e0891091340b45b638207f0b4' }),
]);
