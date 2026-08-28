import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import JobsPage from './page';
import { mockApi, renderWithQuery, requestsByMethod, type ApiRequest } from '@/test/test-utils';

// ---------------------------------------------------------------------------
// N4 / WS-8.1. Three DLQ endpoints have been registered and audited since the
// mission-control spec, with no client calling any of them — so every job that
// exhausted its retries, money jobs included, died into a list no operator
// could open. These assert the page reaches all three, and that it keeps two
// distinctions the operator's decision depends on:
//
//   discard ≠ retry   — one is permanent, so only one asks first;
//   empty ≠ blind     — "no dead letters" and "this server cannot see the
//                        queues" must never render the same.
// ---------------------------------------------------------------------------

const settlementFailure = {
  queue: 'settlement',
  id: '910',
  name: 'process-settlements',
  failedReason: 'Error: MMG timeout after 30000ms',
  attemptsMade: 3,
  data: '{"weekStart":"2026-08-24"}',
  finishedOn: 1756300000000,
};

const searchFailure = {
  queue: 'search',
  id: '44',
  name: 'sync-vendor',
  failedReason: 'Error: meilisearch unreachable',
  attemptsMade: 3,
  data: '{"vendorId":"v-1"}',
  finishedOn: 1756290000000,
};

function handler(extra?: (_r: ApiRequest) => { body: unknown; status?: number } | undefined) {
  return (request: ApiRequest) => {
    const handled = extra?.(request);
    if (handled) return handled;
    if (request.url.pathname === '/api/v1/admin/dlq') {
      return { body: { success: true, data: [settlementFailure, searchFailure] } };
    }
    throw new Error(`Unexpected request: ${request.method} ${request.url}`);
  };
}

describe('the dead letters are reachable at all', () => {
  it('lists what died, with the reason and how many attempts it burned', async () => {
    mockApi(handler());
    renderWithQuery(<JobsPage />);

    expect(await screen.findByText('process-settlements')).toBeTruthy();
    expect(screen.getByText(/MMG timeout after 30000ms/)).toBeTruthy();
    expect(screen.getAllByText(/gave up after 3 attempts/).length).toBe(2);
    expect(screen.getByText('sync-vendor')).toBeTruthy();
  });

  it('retries through the requeue endpoint, not by re-enqueuing something new', async () => {
    const fetchMock = mockApi(
      handler((r) =>
        r.url.pathname === '/api/v1/admin/dlq/settlement/910/requeue'
          ? { body: { success: true, data: { retried: true } } }
          : undefined,
      ),
    );
    renderWithQuery(<JobsPage />);
    await screen.findByText('process-settlements');

    await userEvent.click(screen.getAllByRole('button', { name: 'Retry this job' })[0]!);

    await waitFor(() => {
      const posts = requestsByMethod(fetchMock, 'POST');
      expect(posts.some(([input]) => String(input).includes('/dlq/settlement/910/requeue'))).toBe(true);
    });
  });
});

describe('discard is permanent, so it asks first', () => {
  it('does not delete on the first click', async () => {
    const fetchMock = mockApi(handler());
    renderWithQuery(<JobsPage />);
    await screen.findByText('process-settlements');

    await userEvent.click(screen.getAllByRole('button', { name: 'Discard' })[0]!);

    // The confirmation NAMES the job — a permanent action that says only
    // "are you sure?" is a coin flip, not a decision.
    expect(await screen.findByText(/Yes, discard process-settlements/)).toBeTruthy();
    expect(requestsByMethod(fetchMock, 'DELETE')).toHaveLength(0);
  });

  it('deletes only after the named confirmation', async () => {
    const fetchMock = mockApi(
      handler((r) =>
        r.url.pathname === '/api/v1/admin/dlq/settlement/910' && r.method === 'DELETE'
          ? { body: { success: true, data: { discarded: true } } }
          : undefined,
      ),
    );
    renderWithQuery(<JobsPage />);
    await screen.findByText('process-settlements');

    await userEvent.click(screen.getAllByRole('button', { name: 'Discard' })[0]!);
    await userEvent.click(await screen.findByRole('button', { name: /Yes, discard process-settlements/ }));

    await waitFor(() => {
      const deletes = requestsByMethod(fetchMock, 'DELETE');
      expect(deletes.some(([input]) => String(input).includes('/dlq/settlement/910'))).toBe(true);
    });
  });
});

describe('an empty list and a blind server do not look the same', () => {
  it('says nothing died — and says what "nothing" is bounded by', async () => {
    mockApi(() => ({ body: { success: true, data: [] } }));
    renderWithQuery(<JobsPage />);

    expect(await screen.findByText('No jobs have died.')).toBeTruthy();
    // The queue drops failures past its retention, so "empty" is a bounded
    // claim. Stating the bound is the difference between a fact and a promise.
    expect(screen.getByText(/most recent failures/)).toBeTruthy();
  });

  it('reports QUEUES_OFFLINE as not knowing, never as nothing failed', async () => {
    mockApi(() => ({
      status: 503,
      body: {
        success: false,
        error: { code: 'QUEUES_OFFLINE', message: 'Background queues are not running on this server.' },
      },
    }));
    renderWithQuery(<JobsPage />);

    expect(await screen.findByText('This server is not running the queues.')).toBeTruthy();
    expect(screen.getByText(/not the same as no failures/)).toBeTruthy();
    expect(screen.queryByText('No jobs have died.')).toBeNull();
  });
});

describe('a money queue is not one queue among six', () => {
  it('marks the queues where a dead job is revenue', async () => {
    mockApi(handler());
    renderWithQuery(<JobsPage />);

    const settlement = await screen.findByText('settlement');
    const search = screen.getByText('search');
    // Colour is the SECOND signal; the queue name is the first. What is asserted
    // here is that the two are not styled identically.
    expect(settlement.className).not.toBe(search.className);
    expect(settlement.className).toMatch(/red/);
  });
});
