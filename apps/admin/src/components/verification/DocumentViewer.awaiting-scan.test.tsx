import { screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DocumentViewer } from './DocumentViewer';
import { mockApi, renderWithQuery } from '@/test/test-utils';

// [Row 312 · REVIEW-G S3-1 (a)] A document stored while the malware scanner was down (the emergency
// bypass) is not opened by staff until a clean scan: the server refuses with AWAITING_MALWARE_SCAN and
// the viewer says so, plainly, with no "missing file" reject and no stand-in.

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const SENTENCE = /waiting for a malware scan/i;
const RENDER = '/api/v1/verification/render/synthetic?expires=9999999999&reviewer=rev&sig=synthetic-signature-0000';

describe('[Row 312] awaiting malware scan', () => {
  it('the audited door refuses: the viewer says the document is waiting for a malware scan', async () => {
    mockApi((r) => r.url.pathname.endsWith('/document-url')
      ? { status: 409, body: { success: false, error: { code: 'AWAITING_MALWARE_SCAN', message: 'This document is waiting for a malware scan.' } } }
      : { body: {} });
    const onViewed = vi.fn();
    const { user } = renderWithQuery(<DocumentViewer id="synthetic" label="National ID" onViewed={onViewed} />);
    await user.click(screen.getByRole('button', { name: /View document/ }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(SENTENCE);
    expect(alert.textContent).toMatch(/opens once the scan answers clean/i);
    expect(alert.textContent).not.toMatch(/Try View document again|missing/i);
    expect(screen.queryByRole('button', { name: /Reject missing file/ })).toBeNull();
    expect(screen.queryByAltText('National ID evidence')).toBeNull();
    expect(onViewed).not.toHaveBeenCalledWith(true);
  });

  it('the render door refuses (code relayed by the same-origin proxy): the same words', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes('/document-url')) {
        return new Response(JSON.stringify({ success: true, data: { url: RENDER, expiresInSeconds: 300, signupSelfie: null } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response(null, { status: 409, headers: { 'X-Swift-Error-Code': 'AWAITING_MALWARE_SCAN' } });
    }));
    const { user } = renderWithQuery(<DocumentViewer id="synthetic" label="National ID" onViewed={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: /View document/ }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(SENTENCE);
    expect(screen.queryByAltText('National ID evidence')).toBeNull();
  });
});
