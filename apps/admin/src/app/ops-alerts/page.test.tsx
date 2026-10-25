import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import OpsAlertsPage from './page';
import { API_ORIGIN, mockApi, renderWithQuery, requestsByMethod, type ApiRequest } from '@/test/test-utils';

// ---------------------------------------------------------------------------
// [DRILL-STORM · S-19] Ops alerts: the console's place to acknowledge a page.
// Until it existed nothing in the console called the acknowledgement, so an
// unacknowledged page (the weekly drill included) re-paged forever. Asserted:
// every open page is listed with what it is, when it opened and whether it is
// overdue; Acknowledge asks in the page (no reason, no browser prompt), posts
// to the server's one acknowledgement route and says the re-pages stopped;
// failed drills stay listed for platform operators and are hidden (not an
// error) for a tenant admin the server refuses; a drill can be run from here.
// ---------------------------------------------------------------------------

const SOS = {
  id: 'ops-sos-1', tenantId: null, kind: 'SOS', sosAlertId: 'sos-1',
  title: 'URGENT: SOS ACTIVE', body: 'A rider pressed SOS on order SW-1001. Open the war room now.',
  ackDeadlineAt: '2026-10-25T16:02:00.000Z', escalationLevel: 3, lastEscalatedAt: '2026-10-25T16:20:00.000Z',
  createdAt: '2026-10-25T16:00:00.000Z',
  recipients: [
    { userId: 'u1', deliveredAt: '2026-10-25T16:00:01.000Z', seenAt: '2026-10-25T16:05:00.000Z', ackedAt: null },
    { userId: 'u2', deliveredAt: '2026-10-25T16:00:01.000Z', seenAt: null, ackedAt: null },
  ],
};
const DRILL = {
  id: 'ops-drill-1', tenantId: null, kind: 'DRILL', sosAlertId: null,
  title: 'Ops alert drill — acknowledge now', body: 'This is a scheduled drill of the SOS paging path.',
  ackDeadlineAt: '2099-01-01T00:02:00.000Z', escalationLevel: 0, lastEscalatedAt: null, createdAt: '2099-01-01T00:00:00.000Z',
  recipients: [{ userId: 'u1', deliveredAt: '2099-01-01T00:00:01.000Z', seenAt: null, ackedAt: null }],
};
const FAILED = {
  id: 'ops-drill-0', title: 'Ops alert drill — acknowledge now', createdAt: '2026-10-22T02:04:20.000Z', ackDeadlineAt: '2026-10-22T02:06:20.000Z',
  closedAt: '2026-10-22T02:19:20.000Z', closeReason: 'drill-failed-unacknowledged', escalationLevel: 2,
  recipients: [{ userId: 'u1', deliveredAt: '2026-10-22T02:04:21.000Z', seenAt: null }],
};

function handler(opts: { open?: unknown[]; failed?: unknown[] | 'forbidden' | 'broken'; extra?: (_r: ApiRequest) => { status?: number; body: unknown } | undefined } = {}) {
  return (request: ApiRequest) => {
    if (request.method === 'GET' && request.url.pathname === '/api/v1/safety/ops-alerts') return { body: { success: true, data: opts.open ?? [SOS, DRILL] } };
    if (request.method === 'GET' && request.url.pathname === '/api/v1/safety/ops-alerts/failed-drills') {
      if (opts.failed === 'broken') return { status: 500, body: { success: false, error: { code: 'INTERNAL', message: 'The server could not answer.' } } };
      return opts.failed === 'forbidden'
        ? { status: 403, body: { success: false, error: { code: 'FORBIDDEN', message: 'Failed drills are for platform operators.' } } }
        : { body: { success: true, data: opts.failed ?? [FAILED] } };
    }
    const handled = opts.extra?.(request);
    if (handled) return handled;
    throw new Error(`Unexpected request: ${request.method} ${request.url}`);
  };
}

describe('Ops alerts', () => {
  it('lists every page waiting for acknowledgement: what it is, when it opened, overdue or not, how often re-paged, who it reached', async () => {
    mockApi(handler());
    renderWithQuery(<OpsAlertsPage />);
    const sos = await screen.findByRole('listitem', { name: 'URGENT: SOS ACTIVE' });
    expect(sos.textContent).toContain('SOS · opened');
    expect(sos.textContent).toContain('A rider pressed SOS on order SW-1001.');
    expect(sos.textContent).toContain('Overdue since');
    expect(sos.textContent).toContain('3 times, last at');
    expect(sos.textContent).toContain('Paged 2 people · delivered to 2 · opened by 1');
    const drill = screen.getByRole('listitem', { name: 'Ops alert drill — acknowledge now' });
    expect(drill.textContent).toContain('Drill · opened');
    expect(drill.textContent).not.toContain('Overdue');
    expect(drill.textContent).not.toContain('Re-paged');
    expect(sos.textContent).not.toMatch(/\bPLATFORM\b|\bDRILL\b/);
  });

  it('acknowledges in the page — no reason, no browser prompt — through the one acknowledgement route, and says the re-pages stopped', async () => {
    const prompt = vi.fn();
    vi.stubGlobal('prompt', prompt);
    let acked = false;
    const fetchMock = mockApi(handler({
      open: [SOS],
      extra: (request) => {
        if (request.method === 'POST' && request.url.pathname === '/api/v1/safety/ops-alerts/ops-sos-1/ack') { acked = true; return { body: { success: true, data: { acknowledged: true } } }; }
        return undefined;
      },
    }));
    const { user } = renderWithQuery(<OpsAlertsPage />);
    await user.click(await screen.findByRole('button', { name: 'Acknowledge…' }));
    const dialog = screen.getByRole('dialog', { name: 'Acknowledge “URGENT: SOS ACTIVE”?' });
    expect(dialog.textContent).toContain('Swift stops re-paging everyone about it');
    expect(dialog.textContent).toContain('This does not close the SOS');
    expect(within(dialog).queryByRole('textbox')).toBeNull();
    await user.click(within(dialog).getByRole('button', { name: 'Acknowledge' }));
    await waitFor(() => expect(acked).toBe(true));
    const [url, init] = requestsByMethod(fetchMock, 'POST')[0]!;
    expect(url).toBe(`${API_ORIGIN}/api/v1/safety/ops-alerts/ops-sos-1/ack`);
    expect(init?.credentials).toBe('include');
    expect(await screen.findByText('Acknowledged. The re-pages have stopped.')).toBeTruthy();
    expect(prompt).not.toHaveBeenCalled();
  });

  it('a page someone else already acknowledged says so instead of claiming it', async () => {
    mockApi(handler({
      open: [SOS],
      extra: (request) => (request.method === 'POST' && request.url.pathname === '/api/v1/safety/ops-alerts/ops-sos-1/ack'
        ? { body: { success: true, data: { acknowledged: false } } } : undefined),
    }));
    const { user } = renderWithQuery(<OpsAlertsPage />);
    await user.click(await screen.findByRole('button', { name: 'Acknowledge…' }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Acknowledge' }));
    expect(await screen.findByText('Already handled: someone acknowledged it first, or it was closed.')).toBeTruthy();
  });

  it('a refused acknowledgement is shown as refused, never as done', async () => {
    mockApi(handler({
      open: [SOS],
      extra: (request) => (request.method === 'POST' && request.url.pathname === '/api/v1/safety/ops-alerts/ops-sos-1/ack'
        ? { status: 403, body: { success: false, error: { code: 'FORBIDDEN', message: 'Platform alerts are acknowledged by platform operators.' } } } : undefined),
    }));
    const { user } = renderWithQuery(<OpsAlertsPage />);
    await user.click(await screen.findByRole('button', { name: 'Acknowledge…' }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Acknowledge' }));
    await waitFor(() => expect(screen.queryByText('Acknowledged. The re-pages have stopped.')).toBeNull());
    expect(await screen.findByText(/platform operators/i)).toBeTruthy();
  });

  it('keeps failed drills visible for platform operators', async () => {
    mockApi(handler());
    renderWithQuery(<OpsAlertsPage />);
    const failed = await screen.findByRole('listitem', { name: /^Failed drill opened/ });
    expect(failed.textContent).toContain('Nobody acknowledged it. It paged 1 person, re-paged 2 times, and was closed at');
  });

  it('hides the failed drills (no error) for a tenant admin the server refuses them to, and still lists their pages', async () => {
    mockApi(handler({ failed: 'forbidden' }));
    renderWithQuery(<OpsAlertsPage />);
    expect(await screen.findByRole('listitem', { name: 'URGENT: SOS ACTIVE' })).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Failed drills' })).toBeNull());
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('a failed drills list that could not be read says so, never "No drill has failed."', async () => {
    mockApi(handler({ failed: 'broken' }));
    renderWithQuery(<OpsAlertsPage />);
    const section = await screen.findByRole('region', { name: 'Failed drills' });
    expect(await within(section).findByRole('alert')).toBeTruthy();
    expect(section.textContent).not.toContain('No drill has failed.');
  });

  it('says plainly when nothing is waiting', async () => {
    mockApi(handler({ open: [], failed: [] }));
    renderWithQuery(<OpsAlertsPage />);
    expect(await screen.findByText('Nothing is waiting for acknowledgement.')).toBeTruthy();
    expect(await screen.findByText('No drill has failed.')).toBeTruthy();
  });

  it('runs a drill from here, after saying what it will do', async () => {
    let ran = false;
    mockApi(handler({
      open: [],
      extra: (request) => {
        if (request.method === 'POST' && request.url.pathname === '/api/v1/safety/ops-alerts/drill') { ran = true; return { body: { success: true, data: { opsAlertId: 'ops-drill-2', recipients: 2, reached: 2 } } }; }
        return undefined;
      },
    }));
    const { user } = renderWithQuery(<OpsAlertsPage />);
    await user.click(await screen.findByRole('button', { name: 'Run a drill…' }));
    const dialog = screen.getByRole('dialog', { name: 'Run a paging drill now?' });
    expect(dialog.textContent).toContain('closed as a FAILED drill');
    await user.click(within(dialog).getByRole('button', { name: 'Run the drill' }));
    await waitFor(() => expect(ran).toBe(true));
    expect(await screen.findByText('The drill is out. Acknowledge it above when it reaches you.')).toBeTruthy();
  });
});
