import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import VerificationPage from './page';
import { mockApi, renderWithQuery, requestsByMethod } from '@/test/test-utils';

// ---------------------------------------------------------------------------
// [ADMIN-AUDIT S2-2 · REVIEW-F #2149 S4-2] A VAT certificate cannot be decided in the Review Center
// (Store VAT decides it), so staying with the applicant must never stop on one.
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
const aliceVat = { ...doc('a3', 'u1', 'Alice', 'vat_registration_certificate'), role: 'VENDOR_OWNER' };
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
      const base = [aliceId, aliceVat, bob].find((d) => d.id === id)!;
      return { body: { data: { ...base, status: outcomes[id] ?? 'APPROVED' } } };
    }
    // The re-reads a decision asks for (queue, other statuses, counts, history) are held; opening the
    // next document's evidence is not a re-read and is answered.
    const evidence = r.url.pathname.endsWith('/document-url') || r.url.pathname.includes('/verification/render/');
    if (gate.decided.length && !evidence) { gate.heldReads += 1; await readsBack; }
    if (r.url.pathname.endsWith('/queue/counts')) return { body: { data: { byLane: { PENDING: { operator: 3, customer: 0 } } } } };
    if (r.url.pathname.endsWith('/queue')) {
      if (r.url.searchParams.get('status') !== 'PENDING') return { body: { data: [], meta: { hasNext: false } } };
      const waiting = [aliceId, aliceVat, bob].filter((d) => !gate.decided.includes(d.id));
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

const documentHeading = () => screen.getByRole('heading', { level: 3, name: /National ID|Vehicle registration|VAT/ }).textContent;

async function approveShown(user: User, label: string) {
  await user.click(screen.getByRole('button', { name: /View document/ }));
  fireEvent.load(await screen.findByAltText(`${label} evidence`));
  await user.click(screen.getByRole('button', { name: 'Approve' }));
  await user.type(within(screen.getByRole('dialog')).getByLabelText('Decision note'), 'Matches the submitted identity');
  await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Confirm approval' }));
}

describe('[ADMIN-AUDIT S2-2 · REVIEW-F #2149 S4-2] a VAT certificate is decided in Store VAT, so it is never the next document', () => {
  it('the applicant\'s only other waiting document is a VAT certificate: the next applicant opens', async () => {
    const f = fixture({});
    const { user } = renderWithQuery(<VerificationPage />);
    await openAlice(user);
    expect(documentHeading()).toBe('National ID');
    await approveShown(user, 'National ID');
    await waitFor(() => expect(requestsByMethod(f.fetch, 'PUT')).toHaveLength(1));
    f.answer();
    expect(await screen.findByRole('heading', { level: 2, name: 'Bob Applicant' })).toBeTruthy();
    expect(screen.getByRole('status').textContent).toContain('Approved National ID for Alice Applicant');
    expect(screen.queryByText(/decided in Store VAT/)).toBeNull();
    f.reads();
  });
});
