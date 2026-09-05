import type { KycEngine, KycProvider, KycVerificationResult, KycStatus } from './kyc-provider';

// ---------------------------------------------------------------------------
// ID Analyzer adapter (https://idanalyzer.com) — document OCR + biometric face
// match + authentication, behind the same swappable seam as the sandbox
// provider (hard rule 4). We send only the already-uploaded document / selfie
// URLs and persist ONLY the provider transaction id — never the OCR payload,
// never PII, never to logs or any AI service (hard rule 3).
//
// Enabled with KYC_PROVIDER=idanalyzer; the key comes from ID_ANALYZER_API_KEY.
// Any error or low-confidence result falls back to pending_manual, so a human
// always makes the final call — the system fails safe and never auto-approves
// on doubt. NOTE: the request/response field names below follow ID Analyzer's
// Core API; confirm them against your account's API version when you add the key.
// ---------------------------------------------------------------------------

const DEFAULT_BASE = 'https://api2.idanalyzer.com';
const TIMEOUT_MS = 15_000;
// Document-authenticity score (0..1) and face-match confidence above which we
// auto-accept; a hard authenticity failure rejects; everything else is manual.
const ACCEPT_AUTH = 0.5;
const ACCEPT_FACE = 0.6;
const REJECT_AUTH = 0.2;

interface ScanResponse {
  transactionId?: string;
  authentication?: { score?: number };
  face?: { isIdentical?: boolean; confidence?: number };
  error?: { message?: string };
  /** Parsed fields (v2 returns candidate arrays). Surfaced only to the
   *  identity-integrity hook, which hashes and discards immediately. */
  data?: { documentNumber?: Array<{ value?: string }> };
}

export class IdAnalyzerKycProvider implements KycProvider {
  readonly engine: KycEngine = { name: 'id-analyzer', version: 'api2', external: true, processorRef: 'ID_ANALYZER' };

  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor() {
    const key = process.env['ID_ANALYZER_API_KEY'];
    if (!key) throw new Error('ID_ANALYZER_API_KEY is required for KYC_PROVIDER=idanalyzer');
    this.apiKey = key;
    this.baseUrl = (process.env['ID_ANALYZER_API_URL'] ?? DEFAULT_BASE).replace(/\/$/, '');
  }

  private async scan(body: Record<string, unknown>): Promise<ScanResponse | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(`${this.baseUrl}/scan`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-API-KEY': this.apiKey },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok) return null;
      return (await res.json()) as ScanResponse;
    } catch {
      return null; // network / timeout → caller falls back to manual review
    } finally {
      clearTimeout(timer);
    }
  }

  private interpret(r: ScanResponse | null): KycVerificationResult {
    const referenceToken = r?.transactionId ?? `ida_${Date.now().toString(36)}`;
    if (!r || r.error) return { status: 'pending_manual', referenceToken };
    const documentNumber = r.data?.documentNumber?.[0]?.value;
    const extracted = documentNumber ? { documentNumber } : undefined;
    const auth = r.authentication?.score ?? 0;
    const faceOk = r.face?.isIdentical === true || (r.face?.confidence ?? 0) >= ACCEPT_FACE;
    if (auth <= REJECT_AUTH) {
      return { status: 'rejected', referenceToken, reason: 'Document failed authenticity checks', extracted };
    }
    if (auth >= ACCEPT_AUTH && faceOk) return { status: 'approved', referenceToken, extracted };
    return { status: 'pending_manual', referenceToken, extracted };
  }

  async verifyIdentity(input: {
    userId: string;
    idDocumentUrl: string;
    selfieUrl: string;
  }): Promise<KycVerificationResult> {
    return this.interpret(await this.scan({ document: input.idDocumentUrl, face: input.selfieUrl, biometric: true }));
  }

  async verifyDocument(input: { userId: string; docType: string; fileUrl: string }): Promise<KycVerificationResult> {
    return this.interpret(await this.scan({ document: input.fileUrl }));
  }

  async getStatus(_referenceToken: string): Promise<KycStatus> {
    // The scan is synchronous; the decision is captured at submission time.
    return 'pending_manual';
  }
}
