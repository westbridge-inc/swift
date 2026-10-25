import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import VerificationPage from './page';
import { mockApi, renderWithQuery, requestsByMethod } from '@/test/test-utils';

// ---------------------------------------------------------------------------
// [PERF row 562 · COORD 00:41Z] The Review Center opens the NEXT applicant at
// the decision's answer. The decision itself stays server-confirmed: nothing
// says "Approved"/"Rejected" and nothing moves before the server answers. But
// once it has answered, the reviewer used to wait for four more reads (queue,
// other statuses, lane counts, the document's history) with the whole
// workspace locked. Those reads now run on their own.
// ---------------------------------------------------------------------------

const doc = (id: string, userId: string, firstName: string, type = 'national_id', role = 'MOVER') => ({
  id, userId, docType: type, role, status: 'PENDING', createdAt: '2026-09-01T00:00:00Z',
  user: { id: userId, firstName, lastName: 'Applicant', phone: '+5926477001', countryCode: 'GY' },
});
const alice = doc('a', 'u1', 'Alice');
const bob = doc('b', 'u2', 'Bob');

/** The decision is held until `answer()`; every read after the answer is held until `reads()`. */
function fixture(outcome: 'APPROVED' | 'PENDING' | 'REJECTED') {
  let answer = () => {};
  let reads = () => {};
  const answered = new Promise<void>((resolve) => { answer = resolve; });
  const readsBack = new Promise<void>((resolve) => { reads = resolve; });
  const gate = { decided: false, heldReads: 0 };
  const fetch = mockApi(async (r) => {
    if (r.method === 'PUT') {
      await answered;
      gate.decided = true;
      return { body: { data: { ...alice, status: outcome } } };
    }
    if (gate.decided) { gate.heldReads += 1; await readsBack; }
    if (r.url.pathname.endsWith('/queue/counts')) return { body: { data: { byLane: { PENDING: { operator: 2, customer: 0 } } } } };
    if (r.url.pathname.endsWith('/queue')) {
      if (r.url.searchParams.get('status') !== 'PENDING') return { body: { data: [], meta: { hasNext: false } } };
      return { body: { data: gate.decided ? [bob] : [alice, bob], meta: { hasNext: false, total: gate.decided ? 1 : 2 } } };
    }
    if (r.url.pathname.includes('/users/')) return { body: { data: {} } };
    if (r.url.pathname.endsWith('/custody')) return { body: { data: { timeline: [] } } };
    if (r.url.pathname.endsWith('/document-url')) return { body: { data: { url: '/api/v1/verification/render/a?expires=1&sig=fixture' } } };
    if (r.url.pathname.includes('/verification/render/')) return { body: { loaded: true } };
    throw new Error(`Unexpected ${r.method} ${r.url.pathname}`);
  });
  return { fetch, gate, answer: () => answer(), reads: () => reads() };
}

async function openAlice(user: ReturnType<typeof renderWithQuery>['user']) {
  const [name] = await screen.findAllByText('Alice Applicant');
  await user.click(within(name!.closest('tr')!).getByRole('button', { name: 'Review' }));
}

describe('[PERF row 562] the Review Center moves on at the decision\'s answer', () => {
  it('approve: nothing moves or says "Approved" before the server answers; at the answer the next applicant opens while the re-reads are still out', async () => {
    const f = fixture('APPROVED');
    const { user, queryClient } = renderWithQuery(<VerificationPage />);
    await openAlice(user);
    await user.click(screen.getByRole('button', { name: /View document/ }));
    fireEvent.load(await screen.findByAltText('National ID evidence'));
    await user.click(screen.getByRole('button', { name: 'Approve' }));
    await user.type(within(screen.getByRole('dialog')).getByLabelText('Decision note'), 'Matches the submitted identity');
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Confirm approval' }));

    // The decision is out and unanswered: still Alice, still waiting, no success words.
    await waitFor(() => expect(requestsByMethod(f.fetch, 'PUT')).toHaveLength(1));
    expect(screen.getByRole('heading', { name: 'Alice Applicant' })).toBeTruthy();
    expect(screen.queryByText(/Approved National ID/)).toBeNull();
    expect(screen.getByRole('button', { name: /national id.*Waiting for review/i })).toBeTruthy();

    // The server answers; NO read after it has come back.
    f.answer();
    expect(await screen.findByRole('heading', { name: 'Bob Applicant' })).toBeTruthy();
    expect(screen.getByRole('status').textContent).toContain('Approved National ID for Alice Applicant');
    expect(f.gate.heldReads).toBeGreaterThan(0); // the re-reads were asked for, and are still out

    // The re-reads still land: the queue the server now holds replaces the old one,
    // and J/K walk that queue (Alice's decided document is no longer in it).
    f.reads();
    await waitFor(() => {
      const queues = queryClient.getQueriesData<Array<{ id: string }>>({ queryKey: ['verification', 'PENDING'] });
      expect(queues.length).toBeGreaterThan(0);
      for (const [, data] of queues) expect(data?.map((d) => d.id)).toEqual(['b']);
    });
    fireEvent.keyDown(window, { key: 'k' });
    expect(screen.getByRole('heading', { name: 'Bob Applicant' })).toBeTruthy();
  });

  it('reject sent for a second review: the server\'s words, then the next applicant at once', async () => {
    const f = fixture('PENDING');
    const { user } = renderWithQuery(<VerificationPage />);
    await openAlice(user);
    await user.click(screen.getByRole('button', { name: 'Reject' }));
    await user.selectOptions(screen.getByLabelText('Reason code'), 'SUSPECTED_TAMPERING');
    await user.type(screen.getByLabelText('Decision note'), 'The name area appears altered');
    await user.click(screen.getByRole('button', { name: 'Confirm rejection' }));
    await waitFor(() => expect(requestsByMethod(f.fetch, 'PUT')).toHaveLength(1));
    expect(screen.queryByText(/not rejected/i, { selector: '[role="status"]' })).toBeNull();
    expect(screen.getByRole('heading', { name: 'Alice Applicant' })).toBeTruthy();

    f.answer();
    expect(await screen.findByRole('heading', { name: 'Bob Applicant' })).toBeTruthy();
    expect(screen.getByRole('status').textContent).toMatch(/not rejected until they do/i);
    expect(f.gate.heldReads).toBeGreaterThan(0);
    f.reads();
  });

  it('the next applicant can be worked at once: the decision buttons are free while the re-reads are out', async () => {
    const f = fixture('REJECTED');
    const { user } = renderWithQuery(<VerificationPage />);
    await openAlice(user);
    await user.click(screen.getByRole('button', { name: 'Reject' }));
    await user.selectOptions(screen.getByLabelText('Reason code'), 'UNREADABLE');
    await user.type(screen.getByLabelText('Decision note'), 'The photo is too dark to read');
    await user.click(screen.getByRole('button', { name: 'Confirm rejection' }));
    f.answer();
    await screen.findByRole('heading', { name: 'Bob Applicant' });
    expect(f.gate.heldReads).toBeGreaterThan(0);
    expect((screen.getByRole('button', { name: 'Reject' }) as HTMLButtonElement).disabled).toBe(false);
    f.reads();
  });
});
