import { afterEach, describe, expect, it, vi } from 'vitest';
import { getKycProvider, ManualReviewKycProvider, SandboxKycProvider } from '../providers/kyc/kyc-provider';

afterEach(() => vi.unstubAllEnvs());

describe('human-only KYC configuration', () => {
  it.each(['production', 'development', 'test', 'loadtest'])('uses the human reviewer in %s', (mode) => {
    vi.stubEnv('NODE_ENV', mode);
    vi.stubEnv('KYC_PROVIDER', 'manual');
    expect(getKycProvider()).toBeInstanceOf(ManualReviewKycProvider);
  });

  it.each(['development', 'test', 'loadtest'])('defaults to human review in %s', (mode) => {
    vi.stubEnv('NODE_ENV', mode);
    vi.stubEnv('KYC_PROVIDER', undefined);
    expect(getKycProvider()).toBeInstanceOf(ManualReviewKycProvider);
  });

  it.each(['production', 'development', 'test', 'loadtest'].flatMap((mode) => ['didit', 'idanalyzer'].map((provider) => ({ mode, provider }))))('refuses external $provider even with credentials in $mode', ({ mode, provider }) => {
    vi.stubEnv('NODE_ENV', mode);
    vi.stubEnv('KYC_PROVIDER', provider);
    vi.stubEnv('DIDIT_API_KEY', 'synthetic-test-key');
    vi.stubEnv('ID_ANALYZER_API_KEY', 'synthetic-test-key');
    expect(() => getKycProvider()).toThrow(/human review|manual/i);
  });

  it.each([undefined, '', 'sandbox', 'MANUAL', 'manual ', 'other'])('requires explicit manual configuration in production: %j', (provider) => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('KYC_PROVIDER', provider);
    expect(() => getKycProvider()).toThrow();
  });

  it('retains the explicit synthetic sandbox for non-production regression tests', () => {
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('KYC_PROVIDER', 'sandbox');
    expect(getKycProvider()).toBeInstanceOf(SandboxKycProvider);
  });
});
