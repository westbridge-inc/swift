import { screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import ModerationPage from './page';
import { API_ORIGIN, mockApi, renderWithQuery, requestsByMethod, type ApiRequest } from '@/test/test-utils';

// ---------------------------------------------------------------------------
// STORE-001. Three moderation queues were filling up with no admin page able
// to open them: content reports, reported reviews, and reviews the profanity
// filter is holding back. These assert the page reaches the right endpoint for
// each, shows the reviewer WHAT was reported rather than an opaque id, and —
// the part that matters most — does not blur the three different meanings of
// "resolve" into one comfortable-looking action.
// ---------------------------------------------------------------------------

const contentReport = {
  id: 'report-1',
  reason: 'HARASSMENT',
  targetType: 'RATING',
  targetId: 'rating-9',
  status: 'PENDING',
  detail: 'they named my child',
  createdAt: '2026-08-26T00:00:00.000Z',
  target: { id: 'rating-9', comment: 'the actual reported words', score: 1, raterId: 'user-3' },
};

const csaeReport = {
  ...contentReport,
  id: 'report-csae',
  reason: 'CSAE',
  detail: undefined,
  target: { id: 'rating-10', comment: 'csae content', score: 1, raterId: 'user-4' },
};

const ratingsPayload = {
  success: true,
  data: {
    held: [{ id: 'held-1', score: 2, comment: 'held by the filter', createdAt: '2026-08-26T00:00:00.000Z' }],
    reports: [{
      id: 'ratingreport-1',
      reason: 'FALSE_CLAIM',
      note: 'never ordered from us',
      createdAt: '2026-08-26T00:00:00.000Z',
      rating: { id: 'rating-77', score: 1, comment: 'reported review text' },
    }],
  },
};

function handler(extra?: (_r: ApiRequest) => { body: unknown } | undefined) {
  return (request: ApiRequest) => {
    if (request.url.pathname === '/api/v1/admin/moderation/reports') {
      return { body: { success: true, pendingTotal: 2, data: [contentReport, csaeReport] } };
    }
    if (request.url.pathname === '/api/v1/admin/ratings/moderation') {
      return { body: ratingsPayload };
    }
    const handled = extra?.(request);
    if (handled) return handled;
    throw new Error(`Unexpected request: ${request.method} ${request.url}`);
  };
}

describe('the moderation queues finally have a reviewer', () => {
  it('shows WHAT was reported, not an opaque id, and the reporter’s words', async () => {
    mockApi(handler());
    renderWithQuery(<ModerationPage />);

    expect(await screen.findByText('the actual reported words')).toBeTruthy();
    expect(screen.getByText(/they named my child/)).toBeTruthy();
    // An opaque target id is exactly what the enrichment exists to avoid.
    expect(screen.queryByText('rating-9')).toBeNull();
  });

  it('states plainly that recording a decision does not remove the content', async () => {
    mockApi(handler());
    renderWithQuery(<ModerationPage />);
    // The API is explicit that this endpoint records a DECISION and enforcement
    // runs elsewhere. If the page implies otherwise, a reviewer believes they
    // have taken something down when they have not. Matched on the paragraph's
    // whole text because the "not" is emphasised into its own element.
    const paragraph = await screen.findByText(
      (_text, node) => {
        const own = node?.textContent ?? '';
        return /Recording a decision here does not remove the content\./.test(own)
          && /Enforcement/.test(own)
          && node?.tagName.toLowerCase() === 'p';
      },
    );
    expect(paragraph).toBeTruthy();
  });

  it('records a content decision through the exact endpoint, with the note', async () => {
    const fetchMock = mockApi(handler((r) => {
      if (r.method === 'PUT' && r.url.pathname === '/api/v1/admin/moderation/reports/report-1') {
        return { body: { success: true, data: {} } };
      }
      return undefined;
    }));
    const { user } = renderWithQuery(<ModerationPage />);

    await screen.findByText('the actual reported words');
    await user.click(screen.getAllByRole('button', { name: 'Decide' })[0]!);
    await user.type(screen.getByPlaceholderText(/What did you decide/), 'removed by hand');
    await user.click(screen.getByRole('button', { name: 'Record as actioned' }));

    await waitFor(() => expect(requestsByMethod(fetchMock, 'PUT')).toHaveLength(1));
    const [url, init] = requestsByMethod(fetchMock, 'PUT')[0]!;
    expect(url).toBe(`${API_ORIGIN}/api/v1/admin/moderation/reports/report-1`);
    expect(JSON.parse(String(init?.body))).toEqual({ status: 'ACTIONED', note: 'removed by hand' });
  });

  it('upholding a reported REVIEW hits the endpoint that actually removes it', async () => {
    const fetchMock = mockApi(handler((r) => {
      if (r.method === 'POST' && r.url.pathname === '/api/v1/admin/rating-reports/ratingreport-1/resolve') {
        return { body: { success: true, data: { action: 'uphold' } } };
      }
      return undefined;
    }));
    const { user } = renderWithQuery(<ModerationPage />);

    await user.click(await screen.findByRole('button', { name: /Reported reviews/ }));
    expect(await screen.findByText('reported review text')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: /Uphold/ }));

    await waitFor(() => expect(requestsByMethod(fetchMock, 'POST')).toHaveLength(1));
    const [url, init] = requestsByMethod(fetchMock, 'POST')[0]!;
    expect(url).toBe(`${API_ORIGIN}/api/v1/admin/rating-reports/ratingreport-1/resolve`);
    expect(JSON.parse(String(init?.body))).toEqual({ action: 'uphold' });
  });

  it('publishing a HELD review releases it through the moderate endpoint', async () => {
    const fetchMock = mockApi(handler((r) => {
      if (r.method === 'POST' && r.url.pathname === '/api/v1/admin/ratings/held-1/moderate') {
        return { body: { success: true, data: { action: 'publish' } } };
      }
      return undefined;
    }));
    const { user } = renderWithQuery(<ModerationPage />);

    await user.click(await screen.findByRole('button', { name: /Held reviews/ }));
    expect(await screen.findByText('held by the filter')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Publish it' }));

    await waitFor(() => expect(requestsByMethod(fetchMock, 'POST')).toHaveLength(1));
    const [url, init] = requestsByMethod(fetchMock, 'POST')[0]!;
    expect(url).toBe(`${API_ORIGIN}/api/v1/admin/ratings/held-1/moderate`);
    // publish carries no reason; remove/exclude must.
    expect(JSON.parse(String(init?.body))).toEqual({ action: 'publish' });
  });

  it('removing a held review sends the reason the route requires', async () => {
    const fetchMock = mockApi(handler((r) => {
      if (r.method === 'POST' && r.url.pathname === '/api/v1/admin/ratings/held-1/moderate') {
        return { body: { success: true, data: { action: 'remove' } } };
      }
      return undefined;
    }));
    const { user } = renderWithQuery(<ModerationPage />);

    await user.click(await screen.findByRole('button', { name: /Held reviews/ }));
    await screen.findByText('held by the filter');
    await user.click(screen.getByRole('button', { name: 'Remove' }));

    await waitFor(() => expect(requestsByMethod(fetchMock, 'POST')).toHaveLength(1));
    const [, init] = requestsByMethod(fetchMock, 'POST')[0]!;
    // The route refuses remove/exclude without a reason — sending none would
    // 400 at the moment a reviewer tries to take something down.
    expect(JSON.parse(String(init?.body))).toEqual({ action: 'remove', reason: 'MODERATION' });
  });
});


// ---------------------------------------------------------------------------
// [A-17] A CSAE report closes as a CASE. Swift's published child-safety
// standards promise the material is removed, the account banned, the matter
// reported to the authorities and the evidence preserved — so the console asks
// for those, and a dismissal takes two people.
// ---------------------------------------------------------------------------
describe('[A-17] the child-safety case panel', () => {
  const openCsae = async () => {
    const fetchMock = mockApi(handler());
    const { user } = renderWithQuery(<ModerationPage />);
    await screen.findByText('csae content');
    // The CSAE row is the second one in the fixture queue.
    await user.click(screen.getAllByRole('button', { name: 'Decide' })[1]!);
    return { fetchMock, user };
  };

  it('will not let an operator record it as actioned until the evidence is there', async () => {
    const { fetchMock, user } = await openCsae();
    const actioned = screen.getByRole('button', { name: 'Record as actioned' });
    expect((actioned as HTMLButtonElement).disabled).toBe(true);

    await user.type(screen.getByPlaceholderText(/user:banned/), 'user:banned:abc123');
    expect((screen.getByRole('button', { name: 'Record as actioned' }) as HTMLButtonElement).disabled).toBe(true);

    await user.click(screen.getByLabelText(/evidence needed for those reports has been preserved/i));
    expect((screen.getByRole('button', { name: 'Record as actioned' }) as HTMLButtonElement).disabled).toBe(false);
    expect(requestsByMethod(fetchMock, 'PUT')).toHaveLength(0);
  });

  it('sends the coded disposition and the evidence — and names the authority report when there is one', async () => {
    const { fetchMock, user } = await openCsae();
    await user.type(screen.getByPlaceholderText(/user:banned/), 'user:banned:abc123');
    await user.type(screen.getByPlaceholderText('NCMEC-2026-00417'), 'NCMEC-2026-00417');
    await user.click(screen.getByLabelText(/evidence needed for those reports has been preserved/i));
    await user.click(screen.getByRole('button', { name: 'Record as actioned' }));

    await waitFor(() => expect(requestsByMethod(fetchMock, 'PUT')).toHaveLength(1));
    const [url, init] = requestsByMethod(fetchMock, 'PUT')[0]!;
    expect(url).toBe(`${API_ORIGIN}/api/v1/admin/moderation/reports/report-csae`);
    expect(JSON.parse(String(init?.body))).toEqual({
      status: 'ACTIONED',
      disposition: 'ENFORCED_AND_REPORTED',
      enforcementRef: 'user:banned:abc123',
      authorityRef: 'NCMEC-2026-00417',
      evidencePreserved: true,
    });
  });

  it('a dismissal is PROPOSED, never taken in one click', async () => {
    const { fetchMock, user } = await openCsae();
    expect(screen.queryByRole('button', { name: 'Dismiss' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Propose dismissal' }));

    await waitFor(() => expect(requestsByMethod(fetchMock, 'PUT')).toHaveLength(1));
    expect(JSON.parse(String(requestsByMethod(fetchMock, 'PUT')[0]![1]?.body))).toEqual({
      status: 'PROPOSE_DISMISS',
      disposition: 'NO_VIOLATION',
    });
  });

  it('ordinary moderation keeps its one-click buttons — a spam report is not a case file', async () => {
    mockApi(handler());
    const { user } = renderWithQuery(<ModerationPage />);
    await screen.findByText('the actual reported words');
    await user.click(screen.getAllByRole('button', { name: 'Decide' })[0]!);
    expect(screen.getByRole('button', { name: 'Dismiss' })).toBeTruthy();
    expect(screen.queryByPlaceholderText(/user:banned/)).toBeNull();
  });
});
