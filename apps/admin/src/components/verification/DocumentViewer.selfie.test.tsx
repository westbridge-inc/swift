import { screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DocumentViewer } from './DocumentViewer';
import { mockApi, renderWithQuery } from '@/test/test-utils';

// [Item 98] Face-matching is off at launch (row 54): the reviewer compares the
// applicant's signup selfie with the identity document themselves. The server
// sends the selfie only with a granted view of an identity document.

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function fixture(signupSelfie: unknown) {
  return mockApi((r) => r.url.pathname.endsWith('/document-url')
    ? { body: { success: true, data: { url: '/api/v1/verification/render/synthetic?expires=9999999999&reviewer=rev&sig=synthetic-signature-0000', expiresInSeconds: 300, signupSelfie } } }
    : { body: {} });
}

describe('[Item 98] the reviewer compares the signup selfie with the ID by eye', () => {
  it('shows the captured signup selfie beside the document and says no automatic face matching happens', async () => {
    fixture({ url: '/uploads/avatars/synthetic/selfie.jpg', capturedAt: '2026-10-07T00:00:00.000Z' });
    const { user } = renderWithQuery(<DocumentViewer id="synthetic" label="National ID" onViewed={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: /View document/ }));
    const selfie = await screen.findByAltText('Applicant signup selfie');
    expect(selfie.getAttribute('src')).toBe('http://admin-api.test/uploads/avatars/synthetic/selfie.jpg');
    expect(screen.getByAltText('National ID evidence')).toBeTruthy();
    expect(screen.getByText(/Compare the two faces yourself/i)).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/match(ed|es)? automatically|face.?match(ed)? ✓|verified match/i);
  });

  it('keeps a signed storage address as it is', async () => {
    fixture({ url: 'https://storage.example/avatars/synthetic/selfie.jpg?X-Amz-Signature=abc', capturedAt: '2026-10-07T00:00:00.000Z' });
    const { user } = renderWithQuery(<DocumentViewer id="synthetic" label="National ID" onViewed={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: /View document/ }));
    expect((await screen.findByAltText('Applicant signup selfie')).getAttribute('src')).toBe('https://storage.example/avatars/synthetic/selfie.jpg?X-Amz-Signature=abc');
  });

  it('shows no selfie when the server sends none (never a stand-in photo)', async () => {
    fixture(null);
    const { user } = renderWithQuery(<DocumentViewer id="synthetic" label="National ID" onViewed={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: /View document/ }));
    await screen.findByAltText('National ID evidence');
    expect(screen.queryByAltText('Applicant signup selfie')).toBeNull();
  });
});
