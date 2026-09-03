import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import SupportPage from './page';
import { mockApi, renderWithQuery, requestsByMethod, type ApiRequest } from '@/test/test-utils';

// ---------------------------------------------------------------------------
// [A-18] Closing a support ticket is a decision, and the console has to make
// one. The old screen was a single window.prompt whose CANCEL still fired the
// mutation — a mis-click closed an urgent safety report with no note and no
// disposition, and the reporter got a generic "we've resolved your issue".
//
// These tests drive the real screen: cancel must send nothing, a safety ticket
// must not offer "answered", the close must stay disabled until there is a
// disposition and a note the reporter can read, and a failed queue must never
// render as an empty one.
// ---------------------------------------------------------------------------

const safetyTicket = {
  id: 'ticket-safety',
  category: 'SAFETY',
  subject: 'Driver followed me',
  message: 'The driver was following me after the trip ended.',
  status: 'OPEN',
  createdAt: '2026-09-01T12:00:00.000Z',
  user: { id: 'u1', firstName: 'Ada', lastName: 'R', phone: '+5926000000' },
};

const ordinaryTicket = {
  ...safetyTicket,
  id: 'ticket-order',
  category: 'ORDER_ISSUE',
  subject: 'Cold food',
  message: 'My order arrived cold.',
};

function listOf(tickets: unknown[]) {
  return (request: ApiRequest) => {
    if (request.method === 'GET') return { body: { success: true, data: { tickets, total: tickets.length } } };
    return { body: { success: true, data: {} } };
  };
}

describe('[A-18] cancelling a close sends nothing', () => {
  it('opening the close panel and cancelling makes no request at all', async () => {
    const user = userEvent.setup();
    const fetchMock = mockApi(listOf([ordinaryTicket]));
    renderWithQuery(<SupportPage />);
    await screen.findByText('Cold food');

    await user.click(screen.getByRole('button', { name: /close this ticket/i }));
    await screen.findByRole('button', { name: /^cancel$/i });
    await user.click(screen.getByRole('button', { name: /^cancel$/i }));

    expect(requestsByMethod(fetchMock, 'PUT')).toHaveLength(0);
    // and the panel is gone, so nothing is half-open
    expect(screen.queryByRole('button', { name: /^close ticket$/i })).toBeNull();
  });

  it('the close is refused by the screen until a disposition is chosen', async () => {
    const user = userEvent.setup();
    const fetchMock = mockApi(listOf([ordinaryTicket]));
    renderWithQuery(<SupportPage />);
    await screen.findByText('Cold food');
    await user.click(screen.getByRole('button', { name: /close this ticket/i }));

    const close = await screen.findByRole('button', { name: /^close ticket$/i });
    expect((close as HTMLButtonElement).disabled).toBe(true);
    await user.click(close);
    expect(requestsByMethod(fetchMock, 'PUT')).toHaveLength(0);

    await user.click(screen.getByRole('button', { name: /answered/i }));
    expect((close as HTMLButtonElement).disabled).toBe(false);
    await user.click(close);
    await waitFor(() => expect(requestsByMethod(fetchMock, 'PUT')).toHaveLength(1));
    const [, init] = requestsByMethod(fetchMock, 'PUT')[0]!;
    const body = JSON.parse(String(init?.body));
    expect(body).toMatchObject({ status: 'RESOLVED', resolution: 'ANSWERED', expectedStatus: 'OPEN' });
  });
});

describe('[A-18] a safety report closes on what was done', () => {
  it('offers no "answered" option, and stays disabled until the reporter gets a real note', async () => {
    const user = userEvent.setup();
    const fetchMock = mockApi(listOf([safetyTicket]));
    renderWithQuery(<SupportPage />);
    await screen.findByText('Driver followed me');
    await user.click(screen.getByRole('button', { name: /close this ticket/i }));

    expect(screen.queryByRole('button', { name: /answered \/ information given/i })).toBeNull();
    expect(screen.getByRole('button', { name: /escalated to the safety team/i })).toBeTruthy();

    const close = await screen.findByRole('button', { name: /^close ticket$/i });
    await user.click(screen.getByRole('button', { name: /action taken/i }));
    expect((close as HTMLButtonElement).disabled).toBe(true); // a disposition alone is not enough on a safety report

    await user.type(screen.getByLabelText(/what the reporter will read/i), 'short');
    expect((close as HTMLButtonElement).disabled).toBe(true);
    expect(requestsByMethod(fetchMock, 'PUT')).toHaveLength(0);

    await user.clear(screen.getByLabelText(/what the reporter will read/i));
    await user.type(screen.getByLabelText(/what the reporter will read/i), 'The driver is suspended while the safety team reviews the trip.');
    expect((close as HTMLButtonElement).disabled).toBe(false);
    await user.click(close);
    await waitFor(() => expect(requestsByMethod(fetchMock, 'PUT')).toHaveLength(1));
    const body = JSON.parse(String(requestsByMethod(fetchMock, 'PUT')[0]![1]?.body));
    expect(body.resolution).toBe('ACTION_TAKEN');
    expect(String(body.adminNote).length).toBeGreaterThanOrEqual(20);
  });

  it('the server’s refusal is shown, not swallowed', async () => {
    const user = userEvent.setup();
    mockApi((request) => {
      if (request.method === 'GET') return { body: { success: true, data: { tickets: [safetyTicket], total: 1 } } };
      return { status: 400, body: { success: false, error: { code: 'SAFETY_NOTE_REQUIRED', message: 'Tell the reporter what happened.' } } };
    });
    renderWithQuery(<SupportPage />);
    await screen.findByText('Driver followed me');
    await user.click(screen.getByRole('button', { name: /close this ticket/i }));
    await user.click(screen.getByRole('button', { name: /action taken/i }));
    await user.type(screen.getByLabelText(/what the reporter will read/i), 'The driver is suspended while we review this report.');
    await user.click(screen.getByRole('button', { name: /^close ticket$/i }));

    expect(await screen.findByText(/tell the reporter what happened/i)).toBeTruthy();
  });
});

describe('[A-18] a failed queue is not an empty queue', () => {
  it('a list failure says so, and never says "no tickets"', async () => {
    mockApi(() => ({ status: 503, body: { success: false, error: { code: 'DB_DOWN', message: 'unavailable' } } }));
    renderWithQuery(<SupportPage />);
    expect(await screen.findByText(/this queue could not be loaded/i)).toBeTruthy();
    expect(screen.getByText(/this is not an empty queue/i)).toBeTruthy();
    expect(screen.queryByText(/no open tickets/i)).toBeNull();
  });

  it('an genuinely empty queue still says so', async () => {
    mockApi(listOf([]));
    renderWithQuery(<SupportPage />);
    expect(await screen.findByText(/no open tickets/i)).toBeTruthy();
  });
});
