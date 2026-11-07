import { useState } from 'react';
import { act, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider, focusManager, onlineManager } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import OpsAlertsPage from './page';
import { retryUnlessRefused } from '@/lib/query-retry';
import { CUT_BODIES, cutReads } from '@/test/cut-reads';
import { API_ORIGIN, mockApi, renderWithQuery, requestsByMethod, type ApiReply, type ApiRequest } from '@/test/test-utils';

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

  it('an SOS page opens the Safety board, where the person is handled; the words on the page lead there too', async () => {
    mockApi(handler());
    renderWithQuery(<OpsAlertsPage />);
    const sos = await screen.findByRole('listitem', { name: 'URGENT: SOS ACTIVE' });
    expect(within(sos).getByRole('link', { name: 'Open the Safety board' }).getAttribute('href')).toBe('/safety');
    const drill = screen.getByRole('listitem', { name: 'Ops alert drill — acknowledge now' });
    expect(within(drill).queryByRole('link')).toBeNull();
    expect(screen.getByText(/keep re-paging/).textContent).toMatch(/Handle the person on the Safety board/);
  });

  it('acknowledging an SOS page says where the person is handled', async () => {
    mockApi(handler({ open: [SOS] }));
    const { user } = renderWithQuery(<OpsAlertsPage />);
    await user.click(await screen.findByRole('button', { name: 'Acknowledge…' }));
    expect(screen.getByRole('dialog').textContent).toContain('keep handling the person who asked for help on the Safety board');
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

// [REVIEW-M11] The page that stops the re-pages takes the Safety board's read rules. "Nothing is waiting for acknowledgement."
// over a live SOS page is the same false all-clear: it is said only on a read of this visit, under 45 seconds old.
describe('[LIVE READ] “Nothing is waiting” needs a recent read', () => {
  const NONE = 'Nothing is waiting for acknowledgement.';
  const PATH = '/api/v1/safety/ops-alerts';
  type Read = unknown[] | ApiReply | 'network-down' | 'hangs';
  const board = (ui = <OpsAlertsPage />) => renderWithQuery(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { staleTime: 30_000, refetchOnWindowFocus: false, retry: retryUnlessRefused } } })}>{ui}</QueryClientProvider>,
  );
  const answer = (v: Read): ApiReply | Promise<ApiReply> => {
    if (v === 'network-down') throw new TypeError('Failed to fetch');
    if (v === 'hangs') return new Promise<ApiReply>(() => undefined);
    return Array.isArray(v) ? { body: { success: true, data: v } } : v;
  };
  function serve(pages: Read = [], drills: Read = []) {
    const state = { pages, drills };
    const fetchMock = mockApi((r) => (r.url.pathname === PATH ? answer(state.pages) : answer(state.drills)));
    return { fetchMock, state };
  }
  const reads = (fetchMock: ReturnType<typeof mockApi>) => fetchMock.mock.calls.filter(([url]) => new URL(String(url)).pathname === PATH);
  const page = () => screen.findByRole('listitem', { name: 'URGENT: SOS ACTIVE' });
  const advance = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));

  describe.each(CUT_BODIES)('%s', (_name, cut) => {
    it('with a page on screen: it stays, Acknowledge stays, and the screen says it was not read', async () => {
      const { fetchMock } = serve([SOS]);
      const cutting = cutReads(fetchMock, PATH, cut);
      const { queryClient } = renderWithQuery(<OpsAlertsPage />);
      await page();
      cutting.on = true;
      await act(() => queryClient.invalidateQueries({ queryKey: ['ops-alerts'] }));
      expect(await screen.findByText(/Not read since/)).toBeTruthy();
      expect(screen.queryByText(NONE)).toBeNull();
      expect(within(await page()).getByRole('button', { name: 'Acknowledge…' })).toBeTruthy();
    });
    it('on the first read: a failed read, never “Nothing is waiting”', async () => {
      const { fetchMock } = serve();
      cutReads(fetchMock, PATH, cut).on = true;
      renderWithQuery(<OpsAlertsPage />);
      expect(await screen.findByText(/Couldn't load the ops alerts/)).toBeTruthy();
      expect(screen.queryByText(NONE)).toBeNull();
    });
    it('failed drills: a failed read, never “No drill has failed.”', async () => {
      const { fetchMock } = serve();
      cutReads(fetchMock, '/api/v1/safety/ops-alerts/failed-drills', cut).on = true;
      renderWithQuery(<OpsAlertsPage />);
      expect(await screen.findByText(/Couldn't load the failed drills/)).toBeTruthy();
      expect(screen.queryByText('No drill has failed.')).toBeNull();
    });
  });

  it('a failed refresh keeps the pages and their button: an outage must not take away the way to stop a re-page', async () => {
    const { state } = serve([SOS]);
    const { queryClient } = renderWithQuery(<OpsAlertsPage />);
    await page();
    state.pages = { status: 500, body: { success: false, error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred' } } };
    await act(() => queryClient.invalidateQueries({ queryKey: ['ops-alerts'] }));
    expect(await screen.findByText(/Not read since \d\d:\d\d:\d\d\. There may be a page waiting\./)).toBeTruthy();
    expect(within(await page()).getByRole('button', { name: 'Acknowledge…' })).toBeTruthy();
  });

  it('a 429 keeps them too; a 403 takes them away, so no button stays', async () => {
    const { state } = serve([SOS]);
    const { queryClient } = renderWithQuery(<OpsAlertsPage />);
    await page();
    state.pages = { status: 429, body: { success: false, error: { code: 'RATE_LIMITED', message: 'Too many requests' } } };
    await act(() => queryClient.invalidateQueries({ queryKey: ['ops-alerts'] }));
    expect(await screen.findByText(/Not read since/)).toBeTruthy();
    await page();
    state.pages = { status: 403, body: { success: false, error: { code: 'FORBIDDEN', message: 'Only ops can list alerts.' } } };
    await act(() => queryClient.invalidateQueries({ queryKey: ['ops-alerts'] }));
    await waitFor(() => expect(screen.queryByRole('listitem', { name: 'URGENT: SOS ACTIVE' })).toBeNull());
    expect(screen.queryByRole('button', { name: 'Acknowledge…' })).toBeNull();
    expect(screen.getByText('Only ops can list alerts.')).toBeTruthy();
  });

  describe('with the clock and the network under test', () => {
    beforeEach(() => { vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] }); });
    afterEach(() => { vi.useRealTimers(); onlineManager.setOnline(true); focusManager.setFocused(undefined); });

    it('prints when it was read, to the second', async () => {
      serve();
      board();
      await screen.findByText(NONE);
      expect(screen.getByText(/^Read at \d\d:\d\d:\d\d$/)).toBeTruthy();
    });

    it('the Wi-Fi drops after a good read: the read still runs, fails, and the line goes', async () => {
      const { fetchMock, state } = serve();
      board();
      await screen.findByText(NONE);
      const before = reads(fetchMock).length;
      state.pages = 'network-down';
      act(() => { onlineManager.setOnline(false); });
      await advance(15_000);
      expect(reads(fetchMock).length).toBeGreaterThan(before);
      expect(screen.queryByText(NONE)).toBeNull();
      expect(screen.getByText(/Not read since/)).toBeTruthy();
    });

    it('offline at first load: says so', async () => {
      act(() => { onlineManager.setOnline(false); });
      serve('network-down', 'network-down');
      board();
      expect(await screen.findByText(/Couldn't load the ops alerts/)).toBeTruthy();
      expect(await screen.findByText(/Couldn't load the failed drills/)).toBeTruthy();
    });

    it('a read that hangs is given up on at 10 seconds', async () => {
      const { fetchMock, state } = serve();
      board();
      await screen.findByText(NONE);
      state.pages = 'hangs';
      await advance(15_000);
      const hung = reads(fetchMock).at(-1)!;
      await advance(10_500);
      expect((hung[1]?.signal as AbortSignal).aborted).toBe(true);
      expect(screen.queryByText(NONE)).toBeNull();
      expect(screen.getByText(/Not read since/)).toBeTruthy();
    });

    it('a hidden tab keeps reading, and a tab coming back reads at once', async () => {
      const { fetchMock } = serve();
      board();
      await screen.findByText(NONE);
      act(() => { focusManager.setFocused(false); });
      const before = reads(fetchMock).length;
      await advance(15_000);
      expect(reads(fetchMock).length).toBe(before + 1);
      act(() => { focusManager.setFocused(true); });
      await waitFor(() => expect(reads(fetchMock).length).toBe(before + 2));
    });

    it('coming back to the page: no “Nothing is waiting” until this visit’s own read answers', async () => {
      const { state } = serve();
      let show: (_on: boolean) => void = () => undefined;
      function Doors() { const [on, set] = useState(true); show = set; return on ? <OpsAlertsPage /> : null; }
      board(<Doors />);
      await screen.findByText(NONE);
      act(() => show(false));
      state.pages = 'hangs';
      act(() => show(true));
      expect(screen.queryByText(NONE)).toBeNull();
      expect(screen.getByText('Reading the ops alerts…')).toBeTruthy();
    });

    it.each(['focus', 'pageshow', 'visibilitychange'])('a laptop waking on %s: the line goes at once', async (event) => {
      const { state } = serve();
      board();
      await screen.findByText(NONE);
      state.pages = 'hangs';
      vi.setSystemTime(Date.now() + 60_000);
      act(() => { (event === 'visibilitychange' ? document : window).dispatchEvent(new Event(event, { bubbles: true })); });
      expect(screen.queryByText(NONE)).toBeNull();
      expect(screen.getByText(/Not read since/)).toBeTruthy();
    });

    it('the page’s own clock takes the line away with no read and no event, and overdue runs on it', async () => {
      const { state } = serve([{ ...SOS, ackDeadlineAt: new Date(Date.now() + 30_000).toISOString() }]);
      board();
      const card = await page();
      expect(card.textContent).not.toContain('Overdue');
      state.pages = 'hangs';
      vi.setSystemTime(Date.now() + 60_000);
      await advance(1_000);
      expect(screen.getByText(/Not read since/)).toBeTruthy();
      expect((await page()).textContent).toContain('Overdue since');
    });
  });
});
