import { afterEach, describe, expect, it, vi } from 'vitest';
import { mockApi, type ApiRequest } from '@/test/test-utils';
import { sendVatCertificate } from './vendor-api';

// [STORE-VAT · REVIEW-G #2087 S4-1] The VAT certificate is uploaded through the ordinary document upload, then filed by
// the store's VAT route WITH the recorded consent tick: the server treats the tick as optional, so losing it here would
// silently drop the consent-ledger row. The request body is pinned.

afterEach(() => { vi.restoreAllMocks(); });

describe('[O-5] sending the VAT certificate', () => {
  it('uploads the file first, then files it with consent, the notice version and the document_v1 tick', async () => {
    const requests: ApiRequest[] = [];
    mockApi((r) => {
      requests.push(r);
      if (r.url.pathname === '/api/v1/verification/upload') return { body: { success: true, data: { url: 'verification/owner/cert.enc' } } };
      if (r.url.pathname === '/api/v1/vendor/vat/certificate') return { body: { success: true, data: { status: 'PENDING' } } };
      throw new Error(`Unexpected request: ${r.method} ${r.url}`);
    });
    await sendVatCertificate(new File(['%PDF-1.4'], 'certificate.pdf', { type: 'application/pdf' }));
    expect(requests.map((r) => `${r.method} ${r.url.pathname}`)).toEqual(['POST /api/v1/verification/upload', 'POST /api/v1/vendor/vat/certificate']);
    expect(JSON.parse(String(requests[1]!.init?.body))).toEqual({
      fileUrl: 'verification/owner/cert.enc', consent: true, privacyNoticeVersion: 'web-v1', consentTick: 'document_v1',
    });
  });
});
