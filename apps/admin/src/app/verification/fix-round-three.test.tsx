import { readFileSync } from 'node:fs';
import { act, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import VerificationPage from './page';
import { mockApi, renderWithQuery } from '@/test/test-utils';
import { reviewTimeline, timelineLabel } from '@/lib/review-center';
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const at = '2026-09-01T00:00:00Z';
const event = (what: string, actor = 'reviewer', time = at) => ({ at: time, actor, what });
function fixture() {
  mockApi((r) => {
    if (r.url.pathname.endsWith('/queue/counts')) return { body: { data: { byLane: { PENDING: { operator: 1, customer: 0 } } } } };
    if (r.url.pathname.endsWith('/queue')) return { body: { data: r.url.searchParams.get('status') === 'PENDING' ? ['owner_national_id', 'drivers_licence', 'vehicle_insurance'].map((docType, i) => ({ id: `doc${i}`, userId: 'applicant', user: { id: 'applicant', firstName: 'Demo', lastName: 'Applicant' }, docType, role: 'MOVER', status: 'PENDING', createdAt: at })) : [], meta: { hasNext: false } } };
    if (r.url.pathname.includes('/users/')) return { body: { data: { firstName: 'Demo', lastName: 'Reviewer' } } };
    if (r.url.pathname.endsWith('/custody')) return { body: { data: { timeline: [event('AUDIT DSAR_RECTIFICATION_REQUESTED', 'applicant'), event('AUDIT UNKNOWN_ACTION /api/internal/raw-id')] } } };
    throw new Error(`Unexpected ${r.url.pathname}`);
  });
}
describe('round three timeline', () => {
  it('preserves correction requests and unknown actions with their actor and time', () => {
    const events = [event('AUDIT DSAR_RECTIFICATION_REQUESTED', 'applicant'), event('AUDIT UNKNOWN_ACTION /api/internal/raw-id')];
    expect(reviewTimeline(events)).toEqual([
      { ...events[0], label: 'Correction requested by the applicant' },
      { ...events[1], label: 'Other activity' },
    ]);
    expect(timelineLabel('AUDIT KYC_AUTO_APPROVE')).toBe('Automatically approved');
    expect(timelineLabel('AUDIT KYC_AUTO_REJECT')).toBe('Automatically rejected');
    expect(timelineLabel('AUDIT VERIFICATION_SUBMIT')).toBe('Document submitted');
  });
  it('renders unknown and correction activity without raw routes or actor ids', async () => {
    fixture();
    const { user } = renderWithQuery(<VerificationPage />);
    await user.click(await screen.findByRole('button', { name: 'Review', exact: true }));
    await screen.findByText('Correction requested by the applicant');
    const history = screen.getByRole('heading', { name: 'History and audit timeline' }).parentElement!;
    const rows = within(history).getAllByRole('listitem');
    expect(rows).toHaveLength(2);
    expect(rows[0]?.textContent).toContain('Demo Applicant');
    expect(await within(rows[1]!).findByText('Demo Reviewer')).toBeTruthy();
    expect(within(rows[1]!).getByText('Other activity')).toBeTruthy();
    expect(rows.map((row) => row.querySelector('time')?.dateTime)).toEqual([at, at]);
    expect(history.textContent).not.toMatch(/UNKNOWN_ACTION|DSAR_|\/api\/|raw-id/);
  });
  it('combines the separately timestamped audit companion only with the same second and reason', () => {
    const decision = event('DECIDED ESCALATE under SUSPECTED_TAMPERING', 'reviewer', '2026-09-01T00:00:00.123Z');
    const audit = { ...event('AUDIT ESCALATE_VERIFICATION_DOC', 'reviewer', '2026-09-01T00:00:00.456Z'), detail: { reasonCode: 'SUSPECTED_TAMPERING' } };
    expect(reviewTimeline([decision, audit])).toEqual([{ ...decision, label: 'Sent for another review: Looks altered' }]);
    expect(reviewTimeline([audit, decision])).toEqual([{ ...decision, label: 'Sent for another review: Looks altered' }]);
    expect(reviewTimeline([decision, { ...audit, detail: { reasonCode: 'DUPLICATE' } }])).toHaveLength(2);
    expect(reviewTimeline([decision, { ...audit, detail: undefined }])).toHaveLength(2);
    expect(reviewTimeline([decision, { ...audit, at: decision.at, detail: { reasonCode: 'DUPLICATE' } }])).toHaveLength(2);
    expect(reviewTimeline([decision, { ...audit, at: '2026-09-01T00:00:01.123Z' }])).toHaveLength(2);
    expect(reviewTimeline([decision, { ...audit, actor: 'another-reviewer' }])).toHaveLength(2);
  });
  it.each([false, true])('combines only matching escalation decision and audit pairs (audit first=%s)', (auditFirst) => {
    const decision = event('DECIDED ESCALATE under SUSPECTED_TAMPERING');
    const audit = event('AUDIT ESCALATE_VERIFICATION_DOC');
    const events = auditFirst ? [audit, decision] : [decision, audit];
    expect(reviewTimeline(events)).toEqual([{ ...decision, label: 'Sent for another review: Looks altered' }]);
    expect(events).toHaveLength(2);
    expect(reviewTimeline([decision, { ...audit, actor: 'other' }])).toHaveLength(2);
    expect(reviewTimeline([decision, { ...audit, at: '2026-09-02T00:00:00Z' }])).toHaveLength(2);
    expect(reviewTimeline([decision, event('AUDIT REJECT_VERIFICATION_DOC')])).toHaveLength(2);
    expect(reviewTimeline([decision, audit, audit])).toHaveLength(2); // one-to-one, do not erase extra audits
    expect(reviewTimeline([event('DECIDED ESCALATE'), audit])).toHaveLength(2);
  });
});
describe('round three document navigation', () => {
  it('shows the swipe cue only for actual overflow and remeasures resizing', async () => {
    let width = 350;
    let content = 350;
    const callbacks: ResizeObserverCallback[] = [];
    const disconnect = vi.fn();
    vi.stubGlobal('ResizeObserver', class { constructor(cb: ResizeObserverCallback) { callbacks.push(cb); } observe() {} disconnect = disconnect; });
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(() => width);
    vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockImplementation(() => content);
    fixture();
    const { user, unmount } = renderWithQuery(<VerificationPage />);
    await user.click(await screen.findByRole('button', { name: 'Review', exact: true }));
    expect(screen.queryByText('Swipe to see more documents')).toBeNull();
    content = 496;
    act(() => callbacks.forEach((cb) => cb([], {} as ResizeObserver)));
    expect(screen.getByText('Swipe to see more documents')).toBeTruthy();
    width = 600;
    act(() => callbacks.forEach((cb) => cb([], {} as ResizeObserver)));
    expect(screen.queryByText('Swipe to see more documents')).toBeNull();
    unmount();
    expect(disconnect).toHaveBeenCalled();
  });
  it('keeps a phone return control outside the scrolling pane and returns focus to the selected card', async () => {
    fixture();
    const { user } = renderWithQuery(<VerificationPage />);
    await user.click(await screen.findByRole('button', { name: 'Review', exact: true }));
    const nav = screen.getByRole('navigation', { name: 'Applicant documents' });
    const pane = nav.parentElement!;
    const card = within(nav).getByRole('button', { name: /Driver's licence/ });
    await user.click(card);
    pane.scrollTop = 400;
    const back = screen.getByRole('button', { name: 'Back to documents and zoom · 2 of 3' });
    expect(pane.contains(back)).toBe(false);
    await user.click(back);
    expect(pane.scrollTop).toBe(0);
    expect(document.activeElement).toBe(card);
    const css = readFileSync('src/app/globals.css', 'utf8');
    expect(css).toMatch(/\.rc-back-documents\s*\{[^}]*display:\s*none/);
    expect(css.slice(css.indexOf('@media (max-width: 767px)'))).toMatch(/\.rc-back-documents\s*\{[^}]*display:\s*flex/);
  });
});
