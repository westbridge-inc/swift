import { afterEach, describe, expect, it, vi } from 'vitest';
import { getKycProvider, ManualReviewKycProvider, SandboxKycProvider } from '../providers/kyc/kyc-provider';
import { DiditKycProvider } from '../providers/kyc/didit-provider';
import { IdAnalyzerKycProvider } from '../providers/kyc/id-analyzer-provider';
import { biometricFaceMatchEnabled } from '../lib/biometric-guard';

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe('manual-only launch verification policy', () => {
  it.each(['didit', 'idanalyzer', 'sandbox', undefined, '', 'MANUAL', 'manual '])('refuses production provider %s at construction', (provider) => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('KYC_PROVIDER', provider);
    vi.stubEnv('DIDIT_API_KEY', 'unit-test-only');
    vi.stubEnv('ID_ANALYZER_API_KEY', 'unit-test-only');
    expect(() => getKycProvider()).toThrow(/KYC_PROVIDER.*manual/);
  });

  it.each(['auto-approve', 'auto-reject', 'ordinary-upload'])('manual production keeps %s pending without network or extraction', async (marker) => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('KYC_PROVIDER', 'manual');
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const provider = getKycProvider();
    expect(provider).toBeInstanceOf(ManualReviewKycProvider);
    expect(provider.engine).toMatchObject({ name: 'manual-review', external: false });
    const identity = await provider.verifyIdentity({ userId: 'synthetic-user', idDocumentUrl: marker, selfieUrl: marker });
    const document = await provider.verifyDocument({ userId: 'synthetic-user', docType: 'licence', fileUrl: marker });
    for (const result of [identity, document]) {
      expect(result.status).toBe('pending_manual');
      expect(result.extracted).toBeUndefined();
      expect(result.referenceToken).toMatch(/^manual_/);
      expect(await provider.getStatus(result.referenceToken)).toBe('pending_manual');
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(['development', 'test', 'loadtest'])('preserves explicit fixture adapters in %s', (mode) => {
    vi.stubEnv('NODE_ENV', mode);
    vi.stubEnv('DIDIT_API_KEY', 'unit-test-only');
    vi.stubEnv('ID_ANALYZER_API_KEY', 'unit-test-only');
    for (const [name, adapter] of [['sandbox', SandboxKycProvider], ['didit', DiditKycProvider], ['idanalyzer', IdAnalyzerKycProvider]] as const) {
      vi.stubEnv('KYC_PROVIDER', name);
      expect(getKycProvider()).toBeInstanceOf(adapter);
    }
  });

  it('cannot enable biometric matching in production at runtime', () => {
    expect(biometricFaceMatchEnabled({ NODE_ENV: 'production', FEATURE_BIOMETRIC_FACE_MATCH: '1' })).toBe(false);
  });

  it.each(['development', 'test', 'loadtest'])('keeps biometric fixtures explicitly opt-in in %s', (mode) => {
    expect(biometricFaceMatchEnabled({ NODE_ENV: mode })).toBe(false);
    expect(biometricFaceMatchEnabled({ NODE_ENV: mode, FEATURE_BIOMETRIC_FACE_MATCH: '1' })).toBe(true);
  });

  it.each([undefined, '', 'prod'])('does not guess biometric runtime posture for %s', (mode) => {
    expect(() => biometricFaceMatchEnabled({ NODE_ENV: mode, FEATURE_BIOMETRIC_FACE_MATCH: '1' })).toThrow(/NODE_ENV/);
  });
});
