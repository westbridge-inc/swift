import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import VerificationPage from './page';
import { mockApi, renderWithQuery, requestsByMethod } from '@/test/test-utils';

// ---------------------------------------------------------------------------
// [ADMIN-AUDIT S2-2 · REVIEW-F #2149 S4-1] The ORDER: the next document is the one after the
// decided one in the list (then round to the first), never simply the first waiting one.
//
// A decision on ONE document stays with the applicant while
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
const alicePolice = doc('a3', 'u1', 'Alice', 'police_clearance');
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
      const base = [aliceId, aliceReg, alicePolice, bob].find((d) => d.id === id)!;
      return { body: { data: { ...base, status: outcomes[id] ?? 'APPROVED' } } };
    }
    // The re-reads a decision asks for (queue, other statuses, counts, history) are held; opening the
    // next document's evidence is not a re-read and is answered.
    const evidence = r.url.pathname.endsWith('/document-url') || r.url.pathname.includes('/verification/render/');
    if (gate.decided.length && !evidence) { gate.heldReads += 1; await readsBack; }
    if (r.url.pathname.endsWith('/queue/counts')) return { body: { data: { byLane: { PENDING: { operator: 4, customer: 0 } } } } };
    if (r.url.pathname.endsWith('/queue')) {
      if (r.url.searchParams.get('status') !== 'PENDING') return { body: { data: [], meta: { hasNext: false } } };
      const waiting = [aliceId, aliceReg, alicePolice, bob].filter((d) => !gate.decided.includes(d.id));
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

const documentHeading = () => screen.getByRole('heading', { level: 3, name: /National ID|Vehicle registration|Police clearance/ }).textContent;

async function approveShown(user: User, label: string) {
  await user.click(screen.getByRole('button', { name: /View document/ }));
  fireEvent.load(await screen.findByAltText(`${label} evidence`));
  await user.click(screen.getByRole('button', { name: 'Approve' }));
  await user.type(within(screen.getByRole('dialog')).getByLabelText('Decision note'), 'Matches the submitted identity');
  await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Confirm approval' }));
}

describe('[ADMIN-AUDIT S2-2 · REVIEW-F #2149 S4-3] a document-type filter keeps the sweep on that type', () => {
  it('filtered to National ID: after Alice\'s ID, Bob\'s ID opens — not Alice\'s other documents', async () => {
    const f = fixture({});
    const { user } = renderWithQuery(<VerificationPage />);
    await screen.findAllByText('Alice Applicant');
    await user.selectOptions(screen.getByLabelText('Document type'), 'national_id');
    await openAlice(user);
    expect(documentHeading()).toBe('National ID');
    await approveShown(user, 'National ID');
    await waitFor(() => expect(requestsByMethod(f.fetch, 'PUT')).toHaveLength(1));
    f.answer();
    expect(await screen.findByRole('heading', { level: 2, name: 'Bob Applicant' })).toBeTruthy();
    expect(documentHeading()).toBe('National ID');
    f.reads();
  });
  it('with no filter, the applicant\'s other documents still come first', async () => {
    const f = fixture({});
    const { user } = renderWithQuery(<VerificationPage />);
    await openAlice(user);
    await approveShown(user, 'National ID');
    await waitFor(() => expect(requestsByMethod(f.fetch, 'PUT')).toHaveLength(1));
    f.answer();
    await waitFor(() => expect(documentHeading()).toBe('Vehicle registration'));
    expect(screen.getByRole('heading', { level: 2, name: 'Alice Applicant' })).toBeTruthy();
    f.reads();
  });
});

describe('[ADMIN-AUDIT S2-2 · REVIEW-F #2149 S4-1] the next waiting document is the one AFTER the decided one in the list', () => {
  it('decide the middle of three: the third opens (not the first); then the first', async () => {
    const f = fixture({});
    const { user } = renderWithQuery(<VerificationPage />);
    await openAlice(user);
    expect(documentHeading()).toBe('National ID');
    await user.click(within(screen.getByRole('navigation', { name: 'Applicant documents' })).getByRole('button', { name: /Vehicle registration/ }));
    expect(documentHeading()).toBe('Vehicle registration');
    await approveShown(user, 'Vehicle registration');
    await waitFor(() => expect(requestsByMethod(f.fetch, 'PUT')).toHaveLength(1));
    f.answer();
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('Approved Vehicle registration'));
    expect(documentHeading()).toBe('Police clearance');
    await approveShown(user, 'Police clearance');
    await waitFor(() => expect(requestsByMethod(f.fetch, 'PUT')).toHaveLength(2));
    f.answer();
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('Approved Police clearance'));
    expect(documentHeading()).toBe('National ID');
    expect(screen.getByRole('heading', { level: 2, name: 'Alice Applicant' })).toBeTruthy();
    f.reads();
  });
});
