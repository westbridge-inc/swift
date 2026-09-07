/**
 * [DOC-1 §0.5 / §10.4 · FD-D5 · NO-AI] Face-match is GONE, not merely switched off.
 *
 * This was a kill switch: face-match ran inside the KYC providers (Didit
 * `/face-match`, ID Analyzer `biometric: true`) and the founder's FD-D5
 * decision left it OFF unless `FEATURE_BIOMETRIC_FACE_MATCH=1`.
 *
 * Both providers have now been deleted under the owner's no-AI directive, so
 * there is no implementation left for the flag to enable. A switch that claims
 * to turn on a capability the codebase no longer contains is a lie waiting for
 * someone to believe it — an operator would set it, see no error, and assume
 * identities were being matched.
 *
 * So it returns false, always, and the environment variable is ignored. Every
 * call site keeps its honest refusal (liveness answers BIOMETRIC_DISABLED
 * rather than guessing), and this stays a function so that a future
 * human-reviewed identity-assurance workflow has one place to be introduced —
 * deliberately, with its own decision recorded.
 */
export function biometricFaceMatchEnabled(): boolean {
  return false;
}
