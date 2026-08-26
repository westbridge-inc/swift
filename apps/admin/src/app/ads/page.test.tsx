import { screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import AdsReviewPage from './page';
import { API_ORIGIN, mockApi, renderWithQuery, requestsByMethod, type ApiRequest } from '@/test/test-utils';

// ---------------------------------------------------------------------------
// Swift Ads has two gates and neither had a human at it: an advertiser sits at
// PENDING_REVIEW and a creative at PENDING, both with decision endpoints that
// no admin page called. These assert each decision reaches the endpoint that
// actually moves the state, and that the two payload shapes the routes demand
// (a free-text reason for advertisers, an ENUM reason for creatives) are the
// ones sent — a reviewer discovering that as a 400 mid-decision is the failure
// this replaces.
// ---------------------------------------------------------------------------

const advertiser = {
  id: 'adv-1',
  companyName: 'Demerara Rum Co.',
  industry: 'Beverages',
  city: 'Georgetown',
  website: 'https://example.gy',
  contactName: 'A Contact',
  contactEmail: 'a@example.gy',
  contactPhone: '+5926001234',
  legalName: 'Demerara Rum Limited',
  registrationNo: 'GY-12345',
  status: 'PENDING_REVIEW',
  createdAt: '2026-08-26T00:00:00.000Z',
};

const creative = {
  id: 'cre-1',
  campaignId: 'camp-1',
  kind: 'IMAGE',
  fileUrl: 'https://cdn.example/creative.jpg',
  headline: 'Try our new blend',
  body: 'Smooth, local, and on your doorstep.',
  ctaLabel: 'Order now',
  width: 1200,
  height: 628,
  status: 'PENDING',
  createdAt: '2026-08-26T00:00:00.000Z',
};

function handler(extra?: (_r: ApiRequest) => { body: unknown } | undefined) {
  return (request: ApiRequest) => {
    if (request.url.pathname === '/api/v1/admin/ads/advertisers/queue') {
      return { body: { success: true, data: [advertiser] } };
    }
    if (request.url.pathname === '/api/v1/admin/ads/creatives/queue') {
      return { body: { success: true, data: [creative] } };
    }
    const handled = extra?.(request);
    if (handled) return handled;
    throw new Error(`Unexpected request: ${request.method} ${request.url}`);
  };
}

describe('the two ads gates finally have a reviewer', () => {
  it('approving an advertiser hits the endpoint that moves them out of PENDING_REVIEW', async () => {
    const fetchMock = mockApi(handler((r) => {
      if (r.method === 'PUT' && r.url.pathname === '/api/v1/admin/ads/advertisers/adv-1/approve') {
        return { body: { success: true, data: { status: 'APPROVED' } } };
      }
      return undefined;
    }));
    const { user } = renderWithQuery(<AdsReviewPage />);

    expect(await screen.findByText('Demerara Rum Co.')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Approve' }));

    await waitFor(() => expect(requestsByMethod(fetchMock, 'PUT')).toHaveLength(1));
    expect(requestsByMethod(fetchMock, 'PUT')[0]![0]).toBe(`${API_ORIGIN}/api/v1/admin/ads/advertisers/adv-1/approve`);
  });

  it('rejecting an advertiser refuses to send until a reason exists, then sends it', async () => {
    const fetchMock = mockApi(handler((r) => {
      if (r.method === 'PUT' && r.url.pathname === '/api/v1/admin/ads/advertisers/adv-1/reject') {
        return { body: { success: true, data: { status: 'REJECTED' } } };
      }
      return undefined;
    }));
    const { user } = renderWithQuery(<AdsReviewPage />);

    await screen.findByText('Demerara Rum Co.');
    await user.click(screen.getByRole('button', { name: 'Reject…' }));

    // The route demands 3+ chars. Disabled here rather than discovered as a 400.
    const rejectButton = screen.getByRole('button', { name: 'Reject' }) as HTMLButtonElement;
    expect(rejectButton.disabled).toBe(true);
    await user.type(screen.getByPlaceholderText(/Why\?/), 'no registration number');
    expect(rejectButton.disabled).toBe(false);

    await user.click(rejectButton);
    await waitFor(() => expect(requestsByMethod(fetchMock, 'PUT')).toHaveLength(1));
    const [url, init] = requestsByMethod(fetchMock, 'PUT')[0]!;
    expect(url).toBe(`${API_ORIGIN}/api/v1/admin/ads/advertisers/adv-1/reject`);
    expect(JSON.parse(String(init?.body))).toEqual({ reason: 'no registration number' });
  });

  it('shows the creative itself, and approving publishes it', async () => {
    const fetchMock = mockApi(handler((r) => {
      if (r.method === 'PUT' && r.url.pathname === '/api/v1/admin/ads/creatives/cre-1/approve') {
        return { body: { success: true, data: { status: 'APPROVED' } } };
      }
      return undefined;
    }));
    const { user } = renderWithQuery(<AdsReviewPage />);

    await user.click(await screen.findByRole('button', { name: /Creatives/ }));
    expect(await screen.findByText('Try our new blend')).toBeTruthy();
    // A reviewer judging an image must see the image.
    expect((screen.getByAltText('Try our new blend') as HTMLImageElement).src).toBe(creative.fileUrl);

    await user.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(requestsByMethod(fetchMock, 'PUT')).toHaveLength(1));
    expect(requestsByMethod(fetchMock, 'PUT')[0]![0]).toBe(`${API_ORIGIN}/api/v1/admin/ads/creatives/cre-1/approve`);
  });

  it('rejecting a creative sends one of the ENUM reasons the route accepts', async () => {
    const fetchMock = mockApi(handler((r) => {
      if (r.method === 'PUT' && r.url.pathname === '/api/v1/admin/ads/creatives/cre-1/reject') {
        return { body: { success: true, data: { status: 'REJECTED' } } };
      }
      return undefined;
    }));
    const { user } = renderWithQuery(<AdsReviewPage />);

    await user.click(await screen.findByRole('button', { name: /Creatives/ }));
    await screen.findByText('Try our new blend');
    await user.click(screen.getByRole('button', { name: 'Reject…' }));
    await user.selectOptions(screen.getByLabelText('Rejection reason'), 'MISLEADING_CLAIM');
    await user.type(screen.getByPlaceholderText(/Anything else/), 'the claim is not substantiated');
    await user.click(screen.getByRole('button', { name: 'Reject creative' }));

    await waitFor(() => expect(requestsByMethod(fetchMock, 'PUT')).toHaveLength(1));
    const [, init] = requestsByMethod(fetchMock, 'PUT')[0]!;
    // Free text here would be refused by the route's enum.
    expect(JSON.parse(String(init?.body))).toEqual({
      reason: 'MISLEADING_CLAIM',
      notes: 'the claim is not substantiated',
    });
  });

  it('flags a company that gave no legal name or registration number', async () => {
    mockApi((request: ApiRequest) => {
      if (request.url.pathname === '/api/v1/admin/ads/advertisers/queue') {
        return { body: { success: true, data: [{ ...advertiser, legalName: null, registrationNo: null }] } };
      }
      if (request.url.pathname === '/api/v1/admin/ads/creatives/queue') return { body: { success: true, data: [] } };
      throw new Error('unexpected');
    });
    renderWithQuery(<AdsReviewPage />);
    expect(await screen.findByText(/No legal name or registration number/)).toBeTruthy();
  });
});
