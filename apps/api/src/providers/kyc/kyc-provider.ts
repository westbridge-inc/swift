import { nanoid } from 'nanoid';
import { IdAnalyzerKycProvider } from './id-analyzer-provider';
import { DiditKycProvider } from './didit-provider';

// ---------------------------------------------------------------------------
// KycProvider — hard rule 4: every external service sits behind a swappable
// interface. A Sumsub-class adapter slots in later; nothing outside this
// module may know which provider exists. We store only the verification
// RESULT and a reference token — never provider payloads, never to logs,
// never to any AI service.
// ---------------------------------------------------------------------------

export type KycStatus = 'approved' | 'rejected' | 'pending_manual';

export interface KycVerificationResult {
  status: KycStatus;
  /** Provider-side case id — the only provider artifact we persist */
  referenceToken: string;
  reason?: string;
}

export interface KycProvider {
  /** L2 identity check: government ID + selfie. */
  verifyIdentity(input: { userId: string; idDocumentUrl: string; selfieUrl: string }): Promise<KycVerificationResult>;
  /** Single role/business document check. */
  verifyDocument(input: { userId: string; docType: string; fileUrl: string }): Promise<KycVerificationResult>;
  /** Provider-side status by reference token. */
  getStatus(referenceToken: string): Promise<KycStatus>;
}

/**
 * Sandbox adapter — V1's hybrid model routes everything to the manual admin
 * review queue. Deterministic markers in the file reference let tests force
 * the automatic paths:
 *   "auto-approve" -> approved, "auto-reject" -> rejected, else pending_manual.
 */
export class SandboxKycProvider implements KycProvider {
  private decide(url: string): KycVerificationResult {
    if (url.includes('auto-approve')) {
      return { status: 'approved', referenceToken: `sbx_${nanoid(10)}` };
    }
    if (url.includes('auto-reject')) {
      return { status: 'rejected', referenceToken: `sbx_${nanoid(10)}`, reason: 'Document unreadable (sandbox)' };
    }
    return { status: 'pending_manual', referenceToken: `sbx_${nanoid(10)}` };
  }

  async verifyIdentity(input: { userId: string; idDocumentUrl: string; selfieUrl: string }): Promise<KycVerificationResult> {
    // Both files must pass; the selfie marker wins ties so tests can target it
    const combined = `${input.idDocumentUrl} ${input.selfieUrl}`;
    return this.decide(combined);
  }

  async verifyDocument(input: { userId: string; docType: string; fileUrl: string }): Promise<KycVerificationResult> {
    return this.decide(input.fileUrl);
  }

  async getStatus(_referenceToken: string): Promise<KycStatus> {
    return 'pending_manual';
  }
}

/** Provider selection is config, not code. */
export function getKycProvider(): KycProvider {
  const provider = process.env['KYC_PROVIDER'] ?? 'sandbox';
  switch (provider) {
    case 'sandbox':
      return new SandboxKycProvider();
    case 'idanalyzer':
      return new IdAnalyzerKycProvider();
    case 'didit':
      return new DiditKycProvider();
    default:
      throw new Error(`Unknown KYC_PROVIDER: ${provider}`);
  }
}
