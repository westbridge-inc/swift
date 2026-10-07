import { readFileSync } from 'node:fs';
import { act, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import VerificationPage from './page';
import { DocumentViewer } from '@/components/verification/DocumentViewer';
import { mockApi, renderWithQuery } from '@/test/test-utils';
import * as review from '@/lib/review-center';
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const at = '2026-09-01T00:00:00Z';
const expiry = (what: string, time = at) => ({ at: time, actor: 'validator', what });
function fixture() {
  mockApi((r) => {
    if (r.url.pathname.endsWith('/queue/counts')) return { body: { data: { byLane: { PENDING: { operator: 1, customer: 0 } } } } };
    if (r.url.pathname.endsWith('/queue')) return { body: { data: r.url.searchParams.get('status') === 'PENDING' ? ['owner_national_id', 'drivers_licence', 'vehicle_insurance'].map((docType, i) => ({ id: `doc${i}`, userId: 'applicant', user: { id: 'applicant', firstName: 'Demo', lastName: 'Applicant' }, docType, role: 'MOVER', status: 'PENDING', createdAt: at })) : [], meta: { hasNext: false } } };
    if (r.url.pathname.includes('/users/')) return { body: { data: {} } };
    if (r.url.pathname.endsWith('/custody')) return { body: { data: { timeline: [expiry('V_EXPIRY_PLAUSIBLE SKIP UNDETERMINABLE'), expiry('V_NOT_EXPIRED SKIP UNDETERMINABLE'), { at, actor: 'applicant', what: 'AUDIT UNKNOWN_ACTION' }] } } };
    throw new Error(`Unexpected ${r.url.pathname}`);
  });
}
describe('phone review regression fixes', () => {
  it('keeps phone sections in normal flow and reserves decision-bar space inside the scroll pane', () => {
    // Happy DOM has no layout engine: guard the layout contract, leaving pixel proof to coordinator shots.
    const css = readFileSync('src/app/globals.css', 'utf8');
    const phone = css.slice(css.indexOf('@media (max-width: 767px)'));
    expect(phone).toMatch(/\.rc-workspace\s*\{[^}]*display:\s*block/);
    expect(css).toMatch(/padding-bottom:\s*calc\(var\(--rc-actions-height, 0px\) \+ 1rem\)/);
    expect(phone).toMatch(/\.rc-documents\s*\{[^}]*margin-bottom:\s*1rem/);
  });
  it('shows the selected document position and swipe cue, then updates the position', async () => {
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(350);
    vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockReturnValue(496);
    fixture();
    const { user } = renderWithQuery(<VerificationPage />);
    await user.click(await screen.findByRole('button', { name: 'Review', exact: true }));
    const nav = screen.getByRole('navigation', { name: 'Applicant documents' });
    expect(within(nav).getByText('1 of 3')).toBeTruthy();
    expect(within(nav).getByText('Swipe to see more documents')).toBeTruthy();
    await user.click(within(nav).getByRole('button', { name: /Driver's licence/ }));
    expect(within(nav).getByText('2 of 3')).toBeTruthy();
  });
  it('reserves the measured footer height and updates it when decision copy wraps', async () => {
    const callbacks: ResizeObserverCallback[] = [];
    const disconnect = vi.fn();
    vi.stubGlobal('ResizeObserver', class { constructor(cb: ResizeObserverCallback) { callbacks.push(cb); } observe() {} disconnect = disconnect; });
    let height = 104;
    class MeasuredFooter extends HTMLElement {
      getBoundingClientRect() { return { height: this.classList.contains('rc-actions') ? height : 0 } as DOMRect; }
    }
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(MeasuredFooter.prototype.getBoundingClientRect);
    fixture();
    const { user, unmount } = renderWithQuery(<VerificationPage />);
    await user.click(await screen.findByRole('button', { name: 'Review', exact: true }));
    const pane = screen.getByRole('navigation', { name: 'Applicant documents' }).parentElement!;
    expect(pane.style.getPropertyValue('--rc-actions-height')).toBe('104px');
    height = 140;
    act(() => callbacks.forEach((cb) => cb([], {} as ResizeObserver)));
    expect(pane.style.getPropertyValue('--rc-actions-height')).toBe('140px');
    unmount();
    expect(disconnect).toHaveBeenCalled();
  });
  it.each([true, false])('brings freshly opened evidence into the phone pane only (phone=%s)', async (phone) => {
    vi.stubGlobal('matchMedia', () => ({ matches: phone }));
    vi.stubGlobal('fetch', vi.fn(async (url: string) => url.includes('/document-url')
      ? new Response(JSON.stringify({ data: { url: '/api/v1/verification/render/doc?sig=fixture&expires=1' } }), { headers: { 'content-type': 'application/json' } })
      : new Response('image', { headers: { 'content-type': 'image/png' } })));
    class MeasuredEvidence extends HTMLElement {
      getBoundingClientRect() { return { top: this.classList.contains('rc-evidence-viewport') ? 480 : 100 } as DOMRect; }
    }
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(MeasuredEvidence.prototype.getBoundingClientRect);
    const { user } = renderWithQuery(<div className="rc-workspace" data-testid="pane"><DocumentViewer id="doc" label="National ID" onViewed={vi.fn()} /></div>);
    const pane = screen.getByTestId('pane');
    pane.scrollTop = 20;
    await user.click(screen.getByRole('button', { name: 'View document' }));
    await screen.findByAltText('National ID evidence');
    await waitFor(() => expect(pane.scrollTop).toBe(phone ? 400 : 20));
  });
  it('renders one expiry row and retains unknown audit activity', async () => {
    fixture();
    const { user } = renderWithQuery(<VerificationPage />);
    await user.click(await screen.findByRole('button', { name: 'Review', exact: true }));
    expect(await screen.findByText('Expiry check: could not determine')).toBeTruthy();
    const history = screen.getByRole('heading', { name: 'History and audit timeline' }).parentElement!;
    expect(history.querySelectorAll('li')).toHaveLength(2);
    expect(within(history).getByText('Other activity')).toBeTruthy();
    expect(history.textContent).not.toContain('Review activity recorded');
  });
});
describe('expiry timeline presentation', () => {
  it('names concrete audited decisions instead of hiding their operator facts', () => {
    expect(review.timelineLabel('AUDIT APPROVE_VERIFICATION_DOC')).toBe('Approval recorded');
    expect(review.timelineLabel('AUDIT REJECT_VERIFICATION_DOC')).toBe('Rejection recorded');
    expect(review.timelineLabel('AUDIT ESCALATE_VERIFICATION_DOC')).toBe('Sent for another review');
    expect(review.timelineLabel('AUDIT REVOKE_VERIFICATION_DOC')).toBe('Approval revoked');
  });
  it('combines equivalent expiry checks without losing separate runs or differing verdicts', () => {
    const events = [expiry('V_EXPIRY_PLAUSIBLE SKIP UNDETERMINABLE'), expiry('V_NOT_EXPIRED SKIP UNDETERMINABLE'), expiry('V_NOT_EXPIRED FAIL EXPIRED [blocking]', '2026-09-02T00:00:00Z')];
    const output = review.reviewTimeline(events);
    expect(output.map((e) => e.label)).toEqual(['Expiry check: could not determine', 'Expiry check: not expired — failed — blocking']);
    expect(output.map((e) => e.at)).toEqual([at, '2026-09-02T00:00:00Z']);
    expect(review.reviewTimeline([expiry('V_EXPIRY_PLAUSIBLE PASS'), expiry('V_NOT_EXPIRED FAIL EXPIRED [blocking]')]).map((e) => e.label)).toEqual(['Expiry check: date plausibility — passed', 'Expiry check: not expired — failed — blocking']);
    expect(review.reviewTimeline([expiry('V_EXPIRY_PLAUSIBLE PASS'), expiry('V_NOT_EXPIRED PASS')]).map((e) => e.label)).toEqual(['Expiry check: passed']);
    expect(review.reviewTimeline([expiry('V_EXPIRY_PLAUSIBLE PASS'), expiry('V_NOT_EXPIRED PASS [blocking]')])).toHaveLength(2);
    expect(review.reviewTimeline([expiry('V_NOT_EXPIRED PASS'), { ...expiry('V_EXPIRY_PLAUSIBLE PASS'), actor: 'another-validator' }])).toHaveLength(2);
    expect(review.reviewTimeline([{ at, actor: 'reviewer', what: 'AUDIT UNKNOWN_ACTION' }])).toEqual([{ at, actor: 'reviewer', what: 'AUDIT UNKNOWN_ACTION', label: 'Other activity' }]);
    expect(review.reviewTimeline([{ at, actor: 'reviewer', what: 'AUDIT ADMIN PUT /api/v1/admin/verification/:id/approve' }])[0]?.label).toBe('Approval request recorded');
    expect(review.reviewTimeline([expiry('V_EXPIRY_PLAUSIBLE PASS'), expiry('V_NOT_EXPIRED PASS', '2026-09-02T00:00:00Z')])).toHaveLength(2);
    expect(events[0]?.what).toBe('V_EXPIRY_PLAUSIBLE SKIP UNDETERMINABLE');
  });
});
