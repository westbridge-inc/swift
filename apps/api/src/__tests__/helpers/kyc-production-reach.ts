import { vi } from 'vitest';
import { getKycProvider } from '../../providers/kyc/kyc-provider';

/** Every KYC adapter the factory knows by name. */
export const KYC_ADAPTERS = ['sandbox', 'manual', 'didit', 'idanalyzer'] as const;

/**
 * Which external identity processors (register refs) the PRODUCTION factory
 * constructs, and which it refuses — derived by asking the code, never listed.
 * Leaves env stubs in place; callers `vi.unstubAllEnvs()` in afterEach.
 */
export function productionKycReach(): { admitted: Set<string>; refused: Set<string> } {
  vi.stubEnv('DIDIT_API_KEY', 'unit-test-only');
  vi.stubEnv('ID_ANALYZER_API_KEY', 'unit-test-only');
  const admitted = new Set<string>();
  const refused = new Set<string>();
  for (const name of KYC_ADAPTERS) {
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('KYC_PROVIDER', name);
    const engine = getKycProvider().engine;
    if (!engine?.external || !engine.processorRef) continue;
    vi.stubEnv('NODE_ENV', 'production');
    let built = true;
    try { getKycProvider(); } catch { built = false; }
    (built ? admitted : refused).add(engine.processorRef);
  }
  vi.stubEnv('NODE_ENV', 'test');
  return { admitted, refused };
}
