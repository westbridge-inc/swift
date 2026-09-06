/**
 * [DOC-1 §0.5 / §10.4 · FD-D5 · CONFLICT-DOC-2] The biometric kill switch.
 *
 * Face-match runs inside the KYC providers (Didit `/face-match`, ID Analyzer
 * `biometric: true`). DOC-1 forbids any biometric operation unless the DGP-1
 * decision FD-D5 is recorded APPROVED; the founder's recorded default
 * (swift-standard/doc-1/founder-inputs.md, FD-DOC-3 / CONFLICT-DOC-2) is to
 * KEEP face-match on — behind a switch that did not exist. This is the switch.
 *
 * Default ON: no guard is relaxed and the production boot guard that requires
 * a real KYC provider is untouched. The switch is OFF by default (founder decision
 * 2026-09-07, FD-D5 not approved): every biometric call is document-only verification
 * and the shift-selfie liveness check is skipped. `FEATURE_BIOMETRIC_FACE_MATCH=1` turns
 * them on, deterministically, without a deploy — only after FD-D5 is recorded APPROVED.
 */
export function biometricFaceMatchEnabled(env: Record<string, string | undefined> = process.env): boolean {
  // [FD-D5 · founder 2026-09-07] OFF unless explicitly '1': face-match is special-category
  // processing and is not approved. DOC-1 §10.4's default is now the code's default.
  return env['FEATURE_BIOMETRIC_FACE_MATCH'] === '1';
}
