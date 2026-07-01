import type { KycProvider, KycVerificationResult, KycStatus } from './kyc-provider';

// ---------------------------------------------------------------------------
// Didit adapter (https://didit.me) — standalone v3 verification APIs
// (/v3/id-verification/ document check + /v3/face-match/ selfie match), behind
// the same swappable seam as the sandbox / ID Analyzer providers (hard rule 4).
// We send only the already-uploaded document / selfie URLs and persist ONLY the
// provider reference id — never the extracted PII, never to logs or any AI
// service (hard rule 3).
//
// Enabled with KYC_PROVIDER=didit; the key comes from DIDIT_API_KEY. Any error
// or low-confidence result falls back to pending_manual, so a human always makes
// the final call — the system fails safe and never auto-approves on doubt.
//
// Didit also offers a hosted-session flow (POST /v3/session/ -> verification_url
// + webhook) with a richer guided liveness UX. We use the standalone API here so
// it drops into the existing synchronous seam with no onboarding-flow change.
// NOTE: the request/response field names below follow Didit's v3 API as
// documented; confirm them against your account's API version when you add the key.
// ---------------------------------------------------------------------------

const DEFAULT_BASE = 'https://verification.didit.me';
const TIMEOUT_MS = 15_000;
// Face-match confidence (0..1) above which we accept, given a valid document.
const ACCEPT_FACE = 0.6;

interface IdVerificationResponse {
  session_id?: string;
  reference_id?: string;
  status?: string; // 'Approved' | 'Declined' | 'In Review' | 'Not Started' | ...
  error?: { message?: string };
}

interface FaceMatchResponse {
  score?: number; // 0..1
  status?: string;
  error?: { message?: string };
}

export class DiditKycProvider implements KycProvider {
  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor() {
    const key = process.env['DIDIT_API_KEY'];
    if (!key) throw new Error('DIDIT_API_KEY is required for KYC_PROVIDER=didit');
    this.apiKey = key;
    this.baseUrl = (process.env['DIDIT_API_URL'] ?? DEFAULT_BASE).replace(/\/$/, '');
  }

  private async post<T>(path: string, body: Record<string, unknown>): Promise<T | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': this.apiKey },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok) return null;
      return (await res.json()) as T;
    } catch {
      return null; // network / timeout → caller falls back to manual review
    } finally {
      clearTimeout(timer);
    }
  }

  /** Map a Didit status string to our three-way outcome; anything unrecognised
   *  ('In Review', 'Not Started', undefined) stays manual — never auto-decided. */
  private decisionOf(status?: string): 'approved' | 'rejected' | 'unknown' {
    const s = (status ?? '').toLowerCase();
    if (s === 'approved') return 'approved';
    if (s === 'declined' || s === 'rejected') return 'rejected';
    return 'unknown';
  }

  async verifyIdentity(input: {
    userId: string;
    idDocumentUrl: string;
    selfieUrl: string;
  }): Promise<KycVerificationResult> {
    const id = await this.post<IdVerificationResponse>('/v3/id-verification/', {
      id_document: input.idDocumentUrl,
    });
    const referenceToken = id?.session_id ?? id?.reference_id ?? `didit_${Date.now().toString(36)}`;
    if (!id || id.error) return { status: 'pending_manual', referenceToken };

    const docDecision = this.decisionOf(id.status);
    if (docDecision === 'rejected') {
      return { status: 'rejected', referenceToken, reason: 'ID document failed verification' };
    }

    // Face match the selfie against the document portrait.
    const face = await this.post<FaceMatchResponse>('/v3/face-match/', {
      source_image: input.idDocumentUrl,
      target_image: input.selfieUrl,
    });
    const faceOk = (face?.score ?? 0) >= ACCEPT_FACE && this.decisionOf(face?.status) !== 'rejected';

    if (docDecision === 'approved' && faceOk) return { status: 'approved', referenceToken };
    return { status: 'pending_manual', referenceToken };
  }

  async verifyDocument(input: { userId: string; docType: string; fileUrl: string }): Promise<KycVerificationResult> {
    const r = await this.post<IdVerificationResponse>('/v3/id-verification/', { id_document: input.fileUrl });
    const referenceToken = r?.session_id ?? r?.reference_id ?? `didit_${Date.now().toString(36)}`;
    if (!r || r.error) return { status: 'pending_manual', referenceToken };
    const decision = this.decisionOf(r.status);
    if (decision === 'rejected') return { status: 'rejected', referenceToken, reason: 'Document failed verification' };
    if (decision === 'approved') return { status: 'approved', referenceToken };
    return { status: 'pending_manual', referenceToken };
  }

  async getStatus(_referenceToken: string): Promise<KycStatus> {
    // The standalone v3 calls resolve synchronously; the decision is captured at
    // submission time. (A hosted-session integration would poll GET /v3/session/{id}.)
    return 'pending_manual';
  }
}
