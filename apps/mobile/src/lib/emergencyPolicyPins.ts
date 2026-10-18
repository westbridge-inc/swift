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
// EMPTY until the owner has created the key on staging and production and the
// public halves are pinned here in a reviewed PR before an app build. Until then
// the app trusts no served policy and uses its bundled numbers — the same numbers
// Guyana is served today.
//
// Rotation: pin the NEW key here and ship that app build BEFORE the server signs
// with it; remove the old pin in a later build. Never fetch a pin from the server.

export interface EmergencyPolicyPin {
  /** The API's key id, e.g. `ep1-` + 16 hex. */
  readonly kid: string;
  /** The Ed25519 public key: 64 lowercase hex characters. */
  readonly ed25519: string;
}

export const EMERGENCY_POLICY_PINS: readonly EmergencyPolicyPin[] = Object.freeze([]);
