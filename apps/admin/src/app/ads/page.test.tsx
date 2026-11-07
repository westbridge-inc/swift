import { screen, waitFor, within } from '@testing-library/react';
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
    if (request.url.pathname === '/api/v1/admin/ads/link-domains') {
      return { body: { success: true, data: [] } };
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
    // the reason is asked in the in-page panel, never a browser prompt
    const panel = await screen.findByRole('dialog');
    await user.type(within(panel).getByRole('textbox', { name: 'Reason' }), 'Business documents verified and the checklist is complete');
    await user.click(within(panel).getByRole('button', { name: 'Continue' }));

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
    // [S4] approving a creative is confirmed first (one click used to publish it)
    const confirm = await screen.findByRole('dialog');
    expect(requestsByMethod(fetchMock, 'PUT')).toHaveLength(0);
    await user.click(within(confirm).getByRole('button', { name: 'Approve creative' }));
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

// [ADS-ON] A reviewer approves what the ad opens, so what it opens is on the card.
describe('the reviewer sees the link', () => {
  const withLink = (link: unknown, domains: unknown[] = [], extra?: (_r: ApiRequest) => { body: unknown } | undefined) => (request: ApiRequest) => {
    if (request.url.pathname === '/api/v1/admin/ads/advertisers/queue') return { body: { success: true, data: [] } };
    if (request.url.pathname === '/api/v1/admin/ads/creatives/queue') return { body: { success: true, data: [{ ...creative, link }] } };
    if (request.url.pathname === '/api/v1/admin/ads/link-domains') return { body: { success: true, data: domains } };
    const handled = extra?.(request);
    if (handled) return handled;
    throw new Error(`Unexpected request: ${request.method} ${request.url}`);
  };
  const external = { kind: 'EXTERNAL', value: 'https://shop.example.gy/deal', host: 'shop.example.gy', domainId: 'dom-1', domainStatus: 'PENDING', refusal: null };
  const openCreatives = async (user: { click: (_e: Element) => Promise<void> }) => user.click(await screen.findByRole('button', { name: /^Creatives/ }));

  it('an outside link shows the full address, its website, where the website stands, and opens with no referrer', async () => {
    mockApi(withLink(external));
    const { user } = renderWithQuery(<AdsReviewPage />);
    await openCreatives(user);
    const link = await screen.findByRole('link', { name: 'https://shop.example.gy/deal' });
    expect(link.getAttribute('href')).toBe('https://shop.example.gy/deal');
    expect(link.getAttribute('rel')).toContain('noreferrer');
    expect(screen.getByText('shop.example.gy')).toBeTruthy();
    expect(screen.getByText(/Waiting for a decision/)).toBeTruthy();
    expect(screen.getByText('The ad cannot be approved until this website is.')).toBeTruthy();
  });

  it('a website is approved from the card, with a reason, on the endpoint that moves it', async () => {
    const fetchMock = mockApi(withLink(external, [], (r) => {
      if (r.method === 'PUT' && r.url.pathname === '/api/v1/admin/ads/link-domains/dom-1/approve') return { body: { success: true, data: { status: 'APPROVED' } } };
      return undefined;
    }));
    const { user } = renderWithQuery(<AdsReviewPage />);
    await openCreatives(user);
    await user.click(await screen.findByRole('button', { name: 'Approve website' }));
    const panel = await screen.findByRole('dialog');
    await user.type(within(panel).getByRole('textbox', { name: 'Reason' }), 'Checked the shop site: it is the advertiser');
    await user.click(within(panel).getByRole('button', { name: 'Continue' }));
    await waitFor(() => expect(requestsByMethod(fetchMock, 'PUT')).toHaveLength(1));
    const [url, init] = requestsByMethod(fetchMock, 'PUT')[0]!;
    expect(url).toBe(`${API_ORIGIN}/api/v1/admin/ads/link-domains/dom-1/approve`);
    expect((init?.headers as Record<string, string>)['x-swift-reason']).toBe('Checked the shop site: it is the advertiser');
  });

  it('an approved website offers no decision on the card', async () => {
    mockApi(withLink({ ...external, domainStatus: 'APPROVED' }));
    const { user } = renderWithQuery(<AdsReviewPage />);
    await openCreatives(user);
    expect(await screen.findByRole('link', { name: 'https://shop.example.gy/deal' })).toBeTruthy();
    expect(screen.getByText(/Approved/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Approve website' })).toBeNull();
  });

  it('an app store link asks the human question nothing else can answer', async () => {
    mockApi(withLink({ kind: 'APP_STORE', value: 'https://play.google.com/store/apps/details?id=gy.example.app', host: 'play.google.com', domainId: null, domainStatus: null, refusal: null }));
    const { user } = renderWithQuery(<AdsReviewPage />);
    await openCreatives(user);
    expect(await screen.findByText(/Check this is the advertiser's own app/)).toBeTruthy();
  });

  it('a link the server refused is words, never a link to click', async () => {
    mockApi(withLink({ kind: 'REFUSED', value: 'javascript:alert(1)', host: null, domainId: null, domainStatus: null, refusal: 'An ad link must be a secure (https) web address.' }));
    const { user } = renderWithQuery(<AdsReviewPage />);
    await openCreatives(user);
    expect(await screen.findByText('This link cannot run. Reject this ad.')).toBeTruthy();
    expect(screen.getByText(/javascript:alert\(1\)/)).toBeTruthy();
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('an ad with no link says so, and a link inside Swift names where it goes', async () => {
    mockApi(withLink({ kind: 'NONE', value: null, host: null, domainId: null, domainStatus: null, refusal: null }));
    const first = renderWithQuery(<AdsReviewPage />);
    await openCreatives(first.user);
    expect(await screen.findByText('No link: this ad opens nothing.')).toBeTruthy();
    first.unmount();
    mockApi(withLink({ kind: 'INSIDE_SWIFT', value: 'swift://store/a-store', host: null, domainId: null, domainStatus: null, refusal: null }));
    const second = renderWithQuery(<AdsReviewPage />);
    await openCreatives(second.user);
    expect(await screen.findByText('swift://store/a-store')).toBeTruthy();
  });
});

describe('the allow-list tab', () => {
  const domains = [
    { id: 'dom-1', host: 'new.example.gy', status: 'PENDING', reviewedAt: null, reviewedByName: null, reviewNotes: null, createdAt: '2026-11-01T00:00:00.000Z' },
    { id: 'dom-2', host: 'ok.example.gy', status: 'APPROVED', reviewedAt: '2026-11-02T00:00:00.000Z', reviewedByName: 'Ops Person', reviewNotes: null, createdAt: '2026-11-01T00:00:00.000Z' },
    { id: 'dom-3', host: 'no.example.gy', status: 'REJECTED', reviewedAt: '2026-11-02T00:00:00.000Z', reviewedByName: 'Ops Person', reviewNotes: 'It sells a banned item', createdAt: '2026-11-01T00:00:00.000Z' },
  ];
  const tabHandler = (extra?: (_r: ApiRequest) => { body: unknown } | undefined) => (request: ApiRequest) => {
    if (request.url.pathname === '/api/v1/admin/ads/advertisers/queue') return { body: { success: true, data: [] } };
    if (request.url.pathname === '/api/v1/admin/ads/creatives/queue') return { body: { success: true, data: [] } };
    if (request.url.pathname === '/api/v1/admin/ads/link-domains') return { body: { success: true, data: domains } };
    const handled = extra?.(request);
    if (handled) return handled;
    throw new Error(`Unexpected request: ${request.method} ${request.url}`);
  };

  it('counts what waits, and says who decided each website and when', async () => {
    mockApi(tabHandler());
    const { user } = renderWithQuery(<AdsReviewPage />);
    await user.click(await screen.findByRole('button', { name: 'Links (1)' }));
    expect(await screen.findByText('ok.example.gy')).toBeTruthy();
    expect(screen.getAllByText(/Ops Person/).length).toBe(2);
    expect(screen.getByText('Why refused: It sells a banned item')).toBeTruthy();
  });

  it('refusing a website sends the reason the route demands', async () => {
    const fetchMock = mockApi(tabHandler((r) => {
      if (r.method === 'PUT' && r.url.pathname === '/api/v1/admin/ads/link-domains/dom-2/reject') return { body: { success: true, data: { status: 'REJECTED' } } };
      return undefined;
    }));
    const { user } = renderWithQuery(<AdsReviewPage />);
    await user.click(await screen.findByRole('button', { name: 'Links (1)' }));
    const card = (await screen.findByText('ok.example.gy')).closest('li') as HTMLElement;
    await user.click(within(card).getByRole('button', { name: 'Refuse website' }));
    const panel = await screen.findByRole('dialog');
    await user.type(within(panel).getByRole('textbox', { name: 'Reason' }), 'The shop moved to a site we refuse');
    await user.click(within(panel).getByRole('button', { name: 'Continue' }));
    await waitFor(() => expect(requestsByMethod(fetchMock, 'PUT')).toHaveLength(1));
    const [url, init] = requestsByMethod(fetchMock, 'PUT')[0]!;
    expect(url).toBe(`${API_ORIGIN}/api/v1/admin/ads/link-domains/dom-2/reject`);
    expect(JSON.parse(init?.body as string)).toEqual({ reason: 'The shop moved to a site we refuse' });
  });
});
