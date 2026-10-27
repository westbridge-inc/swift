import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import VerificationPage from './page';
import { mockApi, renderWithQuery, requestsByMethod } from '@/test/test-utils';

// ---------------------------------------------------------------------------
// [ADMIN-AUDIT S2-2 · REVIEW-G #2149 S4-1, S4-2] Staying with one applicant makes back-to-back expiring
// documents the normal path (a taxi driver: licence, hire licences, insurance, fitness): the next document must
// open with nothing typed for the last one, Approve locked until its own evidence is opened. And a rejection
// sent for a second review stays PENDING on the server: its chip must never say Approved or Rejected.
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
const aliceId = doc('a1', 'u1', 'Alice', 'drivers_licence');
const aliceReg = doc('a2', 'u1', 'Alice', 'fitness_cert');
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

const documentHeading = () => screen.getByRole('heading', { level: 3, name: /licence|itness/i }).textContent;

async function rejectShown(user: User, code: string) {
  await user.click(screen.getByRole('button', { name: 'Reject' }));
  await user.selectOptions(screen.getByLabelText('Reason code'), code);
  await user.type(screen.getByLabelText('Decision note'), 'The name area appears altered');
  await user.click(screen.getByRole('button', { name: 'Confirm rejection' }));
}

describe('[ADMIN-AUDIT S2-2 · REVIEW-G #2149 S4-1, S4-2] staying with the applicant starts the next document afresh and keeps a second review honest', () => {
  it('staying resets the typed facts: the next document starts with an empty expiry and Approve locked', async () => {
    const f = fixture({ a1: 'APPROVED', a2: 'APPROVED' });
    const { user } = renderWithQuery(<VerificationPage />);
    await openAlice(user);
    const first = documentHeading()!;
    await user.click(screen.getByRole('button', { name: /View document/ }));
    fireEvent.load(await screen.findByAltText(`${first} evidence`));
    fireEvent.change(screen.getByLabelText('Expiry printed on the document'), { target: { value: '2031-05-05' } });
    await user.click(screen.getByRole('button', { name: 'Approve' }));
    await user.type(within(screen.getByRole('dialog')).getByLabelText('Decision note'), 'Matches the submitted identity');
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Confirm approval' }));
    await waitFor(() => expect(requestsByMethod(f.fetch, 'PUT')).toHaveLength(1));
    expect(JSON.parse(String(requestsByMethod(f.fetch, 'PUT')[0]![1]?.body)).expiresAt).toContain('2031-05-05');
    f.answer();
    await waitFor(() => expect(documentHeading()).not.toBe(first));
    expect((screen.getByLabelText('Expiry printed on the document') as HTMLInputElement).value).toBe('');
    expect((screen.getByRole('button', { name: 'Approve' }) as HTMLButtonElement).disabled).toBe(true);
    f.reads();
  });
  it('a second-review answer (PENDING) keeps the decided chip honest: Waiting for review, never Approved/Rejected', async () => {
    const f = fixture({ a1: 'PENDING', a2: 'REJECTED' });
    const { user } = renderWithQuery(<VerificationPage />);
    await openAlice(user);
    const first = documentHeading()!;
    await rejectShown(user, 'SUSPECTED_TAMPERING');
    await waitFor(() => expect(requestsByMethod(f.fetch, 'PUT')).toHaveLength(1));
    f.answer();
    await waitFor(() => expect(documentHeading()).not.toBe(first));
    const chip = screen.getByRole('button', { name: new RegExp(first) });
    expect(chip.textContent).toMatch(/Waiting for review/);
    expect(chip.textContent).not.toMatch(/Approved|Rejected/);
    f.reads();
  });
});
