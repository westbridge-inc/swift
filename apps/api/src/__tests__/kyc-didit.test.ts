import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DiditKycProvider } from '../providers/kyc/didit-provider';
import { getKycProvider } from '../providers/kyc/kyc-provider';

// Unit tests for the Didit standalone-v3 KYC adapter. `fetch` is mocked, so
// nothing hits the network — we assert only our own decision mapping, including
// the fail-safe rule: any doubt (weak match, API error) → pending_manual, never
// an auto-approve.

function httpJson(body: unknown, ok = true): Response {
  return { ok, json: async () => body } as unknown as Response;
}

describe('DiditKycProvider (standalone v3 API)', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    process.env['DIDIT_API_KEY'] = 'test-key';
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env['DIDIT_API_KEY'];
    delete process.env['KYC_PROVIDER'];
    delete process.env['DIDIT_API_URL'];
  });

  it('approves a valid ID with a strong face match', async () => {
    fetchMock
      .mockResolvedValueOnce(httpJson({ session_id: 'sess_1', status: 'Approved' })) // /v3/id-verification/
      .mockResolvedValueOnce(httpJson({ score: 0.92, status: 'Approved' })); // /v3/face-match/
    const r = await new DiditKycProvider().verifyIdentity({
      userId: 'u1',
      idDocumentUrl: 'id.jpg',
      selfieUrl: 'me.jpg',
    });
    expect(r.status).toBe('approved');
    expect(r.referenceToken).toBe('sess_1');
  });

  it('rejects when the document is declined (no face call needed)', async () => {
    fetchMock.mockResolvedValueOnce(httpJson({ session_id: 'sess_2', status: 'Declined' }));
    const r = await new DiditKycProvider().verifyIdentity({
      userId: 'u1',
      idDocumentUrl: 'id.jpg',
      selfieUrl: 'me.jpg',
    });
    expect(r.status).toBe('rejected');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('falls back to manual on a weak face match (never auto-approves on doubt)', async () => {
    fetchMock
      .mockResolvedValueOnce(httpJson({ session_id: 'sess_3', status: 'Approved' }))
      .mockResolvedValueOnce(httpJson({ score: 0.2, status: 'In Review' }));
    const r = await new DiditKycProvider().verifyIdentity({
      userId: 'u1',
      idDocumentUrl: 'id.jpg',
      selfieUrl: 'me.jpg',
    });
    expect(r.status).toBe('pending_manual');
  });

  it('falls back to manual when the API errors', async () => {
    fetchMock.mockResolvedValueOnce(httpJson({}, false)); // non-2xx
    const r = await new DiditKycProvider().verifyIdentity({
      userId: 'u1',
      idDocumentUrl: 'id.jpg',
      selfieUrl: 'me.jpg',
    });
    expect(r.status).toBe('pending_manual');
  });

  it('verifyDocument maps Approved/Declined/unknown', async () => {
    fetchMock
      .mockResolvedValueOnce(httpJson({ reference_id: 'r1', status: 'Approved' }))
      .mockResolvedValueOnce(httpJson({ reference_id: 'r2', status: 'Declined' }))
      .mockResolvedValueOnce(httpJson({ reference_id: 'r3', status: 'In Review' }));
    const p = new DiditKycProvider();
    expect((await p.verifyDocument({ userId: 'u', docType: 'tin', fileUrl: 'a' })).status).toBe('approved');
    expect((await p.verifyDocument({ userId: 'u', docType: 'tin', fileUrl: 'b' })).status).toBe('rejected');
    expect((await p.verifyDocument({ userId: 'u', docType: 'tin', fileUrl: 'c' })).status).toBe('pending_manual');
  });

  it('requires an API key', () => {
    delete process.env['DIDIT_API_KEY'];
    expect(() => new DiditKycProvider()).toThrow(/DIDIT_API_KEY/);
  });

  it('the factory selects Didit for KYC_PROVIDER=didit', () => {
    process.env['KYC_PROVIDER'] = 'didit';
    expect(getKycProvider()).toBeInstanceOf(DiditKycProvider);
  });

  it('the factory never permits sandbox KYC in production', () => {
    const previous = process.env['NODE_ENV'];
    process.env['NODE_ENV'] = 'production';
    delete process.env['KYC_PROVIDER'];
    try {
      expect(() => getKycProvider()).toThrow(/sandbox.*forbidden/i);
    } finally {
      if (previous === undefined) delete process.env['NODE_ENV'];
      else process.env['NODE_ENV'] = previous;
    }
  });
});
