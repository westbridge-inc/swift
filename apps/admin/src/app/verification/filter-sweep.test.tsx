// [ADMIN-AUDIT S2-2 · REVIEW-F #2152 S4-2, S4-3] A filter is a sweep: a role filter keeps the next document on that role,
// and the hop to the next applicant under a filter opens that applicant's first MATCHING document.
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import VerificationPage from './page';
import { mockApi, renderWithQuery, requestsByMethod } from '@/test/test-utils';

const doc = (id: string, userId: string, firstName: string, type: string, role = 'MOVER') => ({
  id, userId, docType: type, role, status: 'PENDING', createdAt: '2026-09-01T00:00:00Z',
  user: { id: userId, firstName, lastName: 'Applicant', phone: '+5926477001', countryCode: 'GY' },
});
const aliceId = doc('a1', 'u1', 'Alice', 'national_id');
const aliceReg = doc('a2', 'u1', 'Alice', 'vehicle_registration', 'CUSTOMER');
const alicePolice = doc('a3', 'u1', 'Alice', 'police_clearance', 'CUSTOMER');
const bobReg = doc('b2', 'u2', 'Bob', 'vehicle_registration');
const bob = doc('b', 'u2', 'Bob', 'national_id');
const ALL = [aliceId, aliceReg, alicePolice, bobReg, bob];
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
      const base = ALL.find((d) => d.id === id)!;
      return { body: { data: { ...base, status: outcomes[id] ?? 'APPROVED' } } };
    }
    // The re-reads a decision asks for (queue, other statuses, counts, history) are held; opening the
    // next document's evidence is not a re-read and is answered.
    const evidence = r.url.pathname.endsWith('/document-url') || r.url.pathname.includes('/verification/render/');
    if (gate.decided.length && !evidence) { gate.heldReads += 1; await readsBack; }
    if (r.url.pathname.endsWith('/queue/counts')) return { body: { data: { byLane: { PENDING: { operator: 4, customer: 0 } } } } };
    if (r.url.pathname.endsWith('/queue')) {
      if (r.url.searchParams.get('status') !== 'PENDING') return { body: { data: [], meta: { hasNext: false } } };
      const waiting = ALL.filter((d) => !gate.decided.includes(d.id));
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


describe('[ADMIN-AUDIT S2-2 · REVIEW-F #2152] a filter is a sweep', () => {
  it('filtered to a role: after Alice\'s MOVER document, the next MOVER document opens (Bob), not Alice\'s CUSTOMER ones', async () => {
    const f = fixture({});
    const { user } = renderWithQuery(<VerificationPage />);
    await screen.findAllByText('Alice Applicant');
    await user.selectOptions(screen.getByLabelText('Applicant role'), 'MOVER');
    await openAlice(user);
    expect(documentHeading()).toBe('National ID');
    await approveShown(user, 'National ID');
    await waitFor(() => expect(requestsByMethod(f.fetch, 'PUT')).toHaveLength(1));
    f.answer();
    expect(await screen.findByRole('heading', { level: 2, name: 'Bob Applicant' })).toBeTruthy();
    f.reads();
  });
  it('filtered to National ID: the hop to Bob opens Bob\'s National ID, not his first document', async () => {
    const f = fixture({});
    const { user } = renderWithQuery(<VerificationPage />);
    await screen.findAllByText('Alice Applicant');
    await user.selectOptions(screen.getByLabelText('Document type'), 'national_id');
    await openAlice(user);
    await approveShown(user, 'National ID');
    await waitFor(() => expect(requestsByMethod(f.fetch, 'PUT')).toHaveLength(1));
    f.answer();
    expect(await screen.findByRole('heading', { level: 2, name: 'Bob Applicant' })).toBeTruthy();
    expect(documentHeading()).toBe('National ID');
    f.reads();
  });
});
