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
 * a real KYC provider is untouched. `FEATURE_BIOMETRIC_FACE_MATCH=0` turns
 * every biometric call into document-only verification (and disables the
 * shift-selfie liveness check), deterministically, without a deploy.
 */
export function biometricFaceMatchEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env['FEATURE_BIOMETRIC_FACE_MATCH'] !== '0';
}
