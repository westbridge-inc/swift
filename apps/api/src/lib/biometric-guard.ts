import { isProduction } from '../utils/runtime-mode';

/** Launch verification is manual-only; biometric fixtures are nonproduction. */
export function biometricFaceMatchEnabled(env: Record<string, string | undefined> = process.env): boolean {
  if (isProduction(env)) return false;
  return env['FEATURE_BIOMETRIC_FACE_MATCH'] === '1';
}
