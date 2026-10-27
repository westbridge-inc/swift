import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import VerificationPage from './page';
import { mockApi, renderWithQuery, requestsByMethod } from '@/test/test-utils';

// ---------------------------------------------------------------------------
// [ADMIN-AUDIT S2-2] A decision on ONE document stays with the applicant while
// they have documents waiting. A rider sends three documents and a taxi driver
// seven; the Review Center used to open the NEXT applicant after every single
// decision, so the reviewer had to find the same person in the queue again for
// each remaining document. Now, at the server's answer, the applicant's next
// waiting document opens; the next applicant opens only when none is left. The
// decision stays server-confirmed: nothing moves before the answer, and the
// decided document's chip shows the status the server answered.
// ---------------------------------------------------------------------------

const doc = (id: string, userId: string, firstName: string, type: string) => ({
  id, userId, docType: type, role: 'MOVER', status: 'PENDING', createdAt: '2026-09-01T00:00:00Z',
  user: { id: userId, firstName, lastName: 'Applicant', phone: '+5926477001', countryCode: 'GY' },
});
const aliceId = doc('a1', 'u1', 'Alice', 'national_id');
const aliceReg = doc('a2', 'u1', 'Alice', 'vehicle_registration');
const bob = doc('b', 'u2', 'Bob', 'national_id');

/** Each decision is held until `answer()`; every read after the first decision is held until `reads()`. */
function fixture(outcomes: Record<string, 'APPROVED' | 'PENDING' | 'REJECTED'>) {
  let release: () => void = () => {};
  let reads = () => {};
  const readsBack = new Promise<void>((resolve) => { reads = resolve; });
  const gate = { decided: [] as string[], heldReads: 0 };
  const fetch = mockApi(async (r) => {
    if (r.method === 'PUT') {
      const id = r.url.pathname.split('/').slice(-2)[0]!;
      await new Promise<void>((resolve) => { release = resolve; });
      gate.decided.push(id);
      const base = [aliceId, aliceReg, bob].find((d) => d.id === id)!;
      return { body: { data: { ...base, status: outcomes[id] ?? 'APPROVED' } } };
    }
    // The re-reads a decision asks for (queue, other statuses, counts, history) are held; opening the
    // next document's evidence is not a re-read and is answered.
    const evidence = r.url.pathname.endsWith('/document-url') || r.url.pathname.includes('/verification/render/');
    if (gate.decided.length && !evidence) { gate.heldReads += 1; await readsBack; }
    if (r.url.pathname.endsWith('/queue/counts')) return { body: { data: { byLane: { PENDING: { operator: 3, customer: 0 } } } } };
    if (r.url.pathname.endsWith('/queue')) {
      if (r.url.searchParams.get('status') !== 'PENDING') return { body: { data: [], meta: { hasNext: false } } };
      const waiting = [aliceId, aliceReg, bob].filter((d) => !gate.decided.includes(d.id));
      return { body: { data: waiting, meta: { hasNext: false, total: waiting.length } } };
    }
    if (r.url.pathname.includes('/users/')) return { body: { data: {} } };
    if (r.url.pathname.endsWith('/custody')) return { body: { data: { timeline: [] } } };
    if (r.url.pathname.endsWith('/document-url')) {
      const id = r.url.pathname.split('/').slice(-2)[0];
      return { body: { data: { url: `/api/v1/verification/render/${id}?expires=1&sig=fixture` } } };
    }
    if (r.url.pathname.includes('/verification/render/')) return { body: { loaded: true } };
    throw new Error(`Unexpected ${r.method} ${r.url.pathname}`);
  });
  return { fetch, gate, answer: () => release(), reads: () => reads() };
}

type User = ReturnType<typeof renderWithQuery>['user'];

async function openAlice(user: User) {
  const [name] = await screen.findAllByText('Alice Applicant');
  await user.click(within(name!.closest('tr')!).getByRole('button', { name: 'Review' }));
}

const documentHeading = () => screen.getByRole('heading', { level: 3, name: /National ID|Vehicle registration/ }).textContent;

async function approveShown(user: User, label: string) {
  await user.click(screen.getByRole('button', { name: /View document/ }));
  fireEvent.load(await screen.findByAltText(`${label} evidence`));
  await user.click(screen.getByRole('button', { name: 'Approve' }));
  await user.type(within(screen.getByRole('dialog')).getByLabelText('Decision note'), 'Matches the submitted identity');
  await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Confirm approval' }));
}

async function rejectShown(user: User, code: string) {
  await user.click(screen.getByRole('button', { name: 'Reject' }));
  await user.selectOptions(screen.getByLabelText('Reason code'), code);
  await user.type(screen.getByLabelText('Decision note'), 'The name area appears altered');
  await user.click(screen.getByRole('button', { name: 'Confirm rejection' }));
}

describe('[ADMIN-AUDIT S2-2] the Review Center stays with the applicant while they have documents waiting', () => {
  it('approve one of two: at the answer the SAME applicant\'s next waiting document opens (its chip says Approved); after the last one the next applicant opens', async () => {
    const f = fixture({ a1: 'APPROVED', a2: 'APPROVED' });
    const { user } = renderWithQuery(<VerificationPage />);
    await openAlice(user);
    expect(documentHeading()).toBe('National ID');

    await approveShown(user, 'National ID');
    await waitFor(() => expect(requestsByMethod(f.fetch, 'PUT')).toHaveLength(1));
    // Nothing moves before the answer.
    expect(documentHeading()).toBe('National ID');
    expect(screen.queryByText(/Approved National ID/)).toBeNull();

    f.answer();
    await waitFor(() => expect(documentHeading()).toBe('Vehicle registration'));
    expect(screen.getByRole('heading', { level: 2, name: 'Alice Applicant' })).toBeTruthy();
    expect(screen.getByRole('status').textContent).toContain('Approved National ID for Alice Applicant');
    // The decided document shows the server's answer; the next one still waits.
    expect(screen.getByRole('button', { name: /National ID.*Approved/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Vehicle registration.*Waiting for review/ })).toBeTruthy();
    expect(f.gate.heldReads).toBeGreaterThan(0); // the re-reads are still out: this happened at the answer

    // The last waiting document: now the next applicant opens, at its answer.
    await approveShown(user, 'Vehicle registration');
    await waitFor(() => expect(requestsByMethod(f.fetch, 'PUT')).toHaveLength(2));
    f.answer();
    expect(await screen.findByRole('heading', { level: 2, name: 'Bob Applicant' })).toBeTruthy();
    expect(screen.getByRole('status').textContent).toContain('Approved Vehicle registration for Alice Applicant');
    f.reads();
  });

  it('a reject sent for a second review stays PENDING on the server, yet it is never offered again: the applicant\'s other document opens, then the next applicant', async () => {
    const f = fixture({ a1: 'PENDING', a2: 'REJECTED' });
    const { user } = renderWithQuery(<VerificationPage />);
    await openAlice(user);
    await rejectShown(user, 'SUSPECTED_TAMPERING');
    await waitFor(() => expect(requestsByMethod(f.fetch, 'PUT')).toHaveLength(1));
    f.answer();
    await waitFor(() => expect(documentHeading()).toBe('Vehicle registration'));
    expect(screen.getByRole('status').textContent).toMatch(/not rejected until they do/i);

    await rejectShown(user, 'UNREADABLE');
    await waitFor(() => expect(requestsByMethod(f.fetch, 'PUT')).toHaveLength(2));
    f.answer();
    // Not back to Alice's National ID (still PENDING for the second reviewer): Bob.
    expect(await screen.findByRole('heading', { level: 2, name: 'Bob Applicant' })).toBeTruthy();
    expect(f.gate.decided).toEqual(['a1', 'a2']);
    f.reads();
  });

  it('a refused decision keeps the applicant AND the document: nothing moves on an error', async () => {
    const fetch = mockApi(async (r) => {
      if (r.method === 'PUT') return { status: 409, body: { success: false, error: { code: 'NOT_PENDING', message: 'This document was already decided.' } } };
      if (r.url.pathname.endsWith('/queue/counts')) return { body: { data: { byLane: { PENDING: { operator: 3, customer: 0 } } } } };
      if (r.url.pathname.endsWith('/queue')) {
        if (r.url.searchParams.get('status') !== 'PENDING') return { body: { data: [], meta: { hasNext: false } } };
        return { body: { data: [aliceId, aliceReg, bob], meta: { hasNext: false, total: 3 } } };
      }
      if (r.url.pathname.includes('/users/')) return { body: { data: {} } };
      if (r.url.pathname.endsWith('/custody')) return { body: { data: { timeline: [] } } };
      if (r.url.pathname.endsWith('/document-url')) return { body: { data: { url: '/api/v1/verification/render/a1?expires=1&sig=fixture' } } };
      if (r.url.pathname.includes('/verification/render/')) return { body: { loaded: true } };
      throw new Error(`Unexpected ${r.method} ${r.url.pathname}`);
    });
    const { user } = renderWithQuery(<VerificationPage />);
    await openAlice(user);
    await approveShown(user, 'National ID');
    await waitFor(() => expect(requestsByMethod(fetch, 'PUT')).toHaveLength(1));
    expect(await within(screen.getByRole('dialog')).findByText(/already decided/)).toBeTruthy();
    expect(documentHeading()).toBe('National ID');
    expect(screen.getByRole('heading', { level: 2, name: 'Alice Applicant' })).toBeTruthy();
  });
});
