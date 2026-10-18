import { vi } from 'vitest';
import { getKycProvider } from '../../providers/kyc/kyc-provider';
import { DiditKycProvider } from '../../providers/kyc/didit-provider';
import { IdAnalyzerKycProvider } from '../../providers/kyc/id-analyzer-provider';

/** Every external identity adapter in source, with the KYC_PROVIDER name that would select it. */
export const EXTERNAL_KYC_ADAPTERS = [['didit', DiditKycProvider], ['idanalyzer', IdAnalyzerKycProvider]] as const;

/**
 * Which external identity processors (register refs) the PRODUCTION factory admits, and which it
 * refuses — asked of the code, never listed by hand. Constructing an adapter makes no request.
 * Leaves env stubs in place; callers `vi.unstubAllEnvs()` in afterEach.
 */
export function productionKycReach(): { admitted: Set<string>; refused: Set<string> } {
  vi.stubEnv('DIDIT_API_KEY', 'unit-test-only');
  vi.stubEnv('ID_ANALYZER_API_KEY', 'unit-test-only');
  const admitted = new Set<string>();
  const refused = new Set<string>();
  for (const [name, Adapter] of EXTERNAL_KYC_ADAPTERS) {
    const ref = new Adapter().engine.processorRef;
    if (!ref) throw new Error(`the ${name} adapter names no processor register entry`);
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('KYC_PROVIDER', name);
    let built = true;
    try { getKycProvider(); } catch { built = false; }
    (built ? admitted : refused).add(ref);
  }
  vi.stubEnv('NODE_ENV', 'test');
  return { admitted, refused };
}
