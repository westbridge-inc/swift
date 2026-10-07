import { screen, waitFor, within } from '@testing-library/react';
import type { UserEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ConfigPage from './config/page';
import CompliancePage from './compliance/page';
import BroadcastPage from './broadcast/page';
import PromosPage from './promos/page';
import DiscoveryPage from './discovery/page';
import ModerationPage from './moderation/page';
import { mockApi, renderWithQuery, requestsByMethod, type ApiRequest } from '@/test/test-utils';

// ---------------------------------------------------------------------------
// [MISSION CONTROL · PR-3b] No browser prompts, anywhere a reason is asked.
//
// Owner ruling (6 Oct): reasons, notes and ids were typed into window.prompt /
// confirm boxes, and the server's answer arrived after the box had gone — a
// refusal was usually never shown, and a platform change "saved" when it had
// only been queued for a second admin. Every page below now asks in the
// page's own panel, sends nothing until the operator has said why, and keeps
// the server's answer on screen.
// ---------------------------------------------------------------------------

const REASON = 'Agreed with the owner on the Tuesday operations call';
const queued = { status: 202, body: { success: false, error: { code: 'APPROVAL_REQUIRED', message: 'A second admin must approve this.', details: { approvalId: 'apr_9' } } } };

let promptSpy: ReturnType<typeof vi.fn>;
let confirmSpy: ReturnType<typeof vi.fn>;
function forbidBrowserPrompts() {
  promptSpy = vi.fn(() => { throw new Error('window.prompt was called'); });
  confirmSpy = vi.fn(() => { throw new Error('window.confirm was called'); });
  vi.stubGlobal('prompt', promptSpy);
  vi.stubGlobal('confirm', confirmSpy);
}
afterEach(() => {
  expect(promptSpy).not.toHaveBeenCalled();
  expect(confirmSpy).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});

async function answer(user: UserEvent, title: string | RegExp, confirmLabel: string, reason = REASON) {
  const dialog = await screen.findByRole('dialog', { name: title });
  await user.type(within(dialog).getByRole('textbox', { name: 'Reason' }), reason);
  await user.click(within(dialog).getByRole('button', { name: confirmLabel }));
  return dialog;
}
const reasonOf = (init: RequestInit | undefined) => (init?.headers as Record<string, string>)['x-swift-reason'];

describe('[MC-PR3b] platform configuration', () => {
  const server = (write: () => { status?: number; body: unknown }) => mockApi((r: ApiRequest) => (r.method === 'GET'
    ? { body: { success: true, data: [{ key: 'order_auto_reject_minutes', value: 10 }] } }
    : write()));

  it('a change shows old → new, asks why, and says it went to a second admin — it never says "Saved."', async () => {
    forbidBrowserPrompts();
    const fetchMock = server(() => queued);
    const { user } = renderWithQuery(<ConfigPage />);
    const input = await screen.findByRole('spinbutton', { name: 'Order Auto-Reject (min)' });
    await waitFor(() => expect((input as HTMLInputElement).value).toBe('10'));
    await user.clear(input);
    await user.type(input, '15');
    await user.click(screen.getByRole('button', { name: 'Save configuration…' }));
    const dialog = screen.getByRole('dialog', { name: 'Change this setting?' });
    expect(within(dialog).getByText('Order Auto-Reject (min): 10 → 15')).toBeTruthy();
    expect(requestsByMethod(fetchMock, 'PUT')).toHaveLength(0);
    await answer(user, 'Change this setting?', 'Send for approval');

    const [url, init] = requestsByMethod(fetchMock, 'PUT')[0]!;
    expect(String(url)).toContain('/api/v1/admin/config/order_auto_reject_minutes');
    expect(JSON.parse(String(init?.body))).toEqual({ value: 15 });
    expect(reasonOf(init)).toBe(REASON);
    const status = await screen.findByRole('status');
    expect(status.textContent).toContain("Sent for a second admin's approval");
    expect(within(status).getByRole('link', { name: 'Open Approvals' }).getAttribute('href')).toBe('/approvals');
    expect(screen.queryByText('Saved.')).toBeNull();
  });

  it('a refusal stays in the panel with the reason still typed, and the edit is kept', async () => {
    forbidBrowserPrompts();
    server(() => ({ status: 403, body: { success: false, error: { code: 'FORBIDDEN', message: 'Your role cannot change platform settings.' } } }));
    const { user } = renderWithQuery(<ConfigPage />);
    const input = await screen.findByRole('spinbutton', { name: 'Order Auto-Reject (min)' });
    await waitFor(() => expect((input as HTMLInputElement).value).toBe('10'));
    await user.clear(input);
    await user.type(input, '20');
    await user.click(screen.getByRole('button', { name: 'Save configuration…' }));
    const dialog = await answer(user, 'Change this setting?', 'Send for approval');
    expect((await within(dialog).findByRole('alert')).textContent).toContain('Your role cannot change platform settings.');
    expect((within(dialog).getByRole('textbox', { name: 'Reason' }) as HTMLTextAreaElement).value).toBe(REASON);
    await user.click(within(dialog).getByRole('button', { name: 'Close' }));
    expect((screen.getByRole('spinbutton', { name: 'Order Auto-Reject (min)' }) as HTMLInputElement).value).toBe('20');
  });
});

describe('[MC-PR3b] compliance decisions', () => {
  const data = {
    runs: [],
    openViolations: [{ id: 'v1', user: { firstName: 'Ana', lastName: 'Mover', phone: '+5926111222' }, reason: 'INSURANCE_EXPIRED', moverKind: 'DRIVER', actionTaken: 'FORCED_OFFLINE', createdAt: '2026-10-05T10:00:00Z', evidence: {} }],
    reviewQueue: [{ id: 'c1', user: { firstName: 'Ben', lastName: 'Driver', phone: '+5926333444' }, dueAt: '2026-10-09T00:00:00Z' }],
  };
  const server = (reply: (_r: ApiRequest) => { status?: number; body: unknown }) => mockApi((r: ApiRequest) => (r.method === 'GET' ? { body: { success: true, data } } : reply(r)));

  it('a failed re-verification needs a note in the same panel; it sends the note and the reason', async () => {
    forbidBrowserPrompts();
    const fetchMock = server(() => ({ body: { success: true, data: { userId: 'u2' } } }));
    const { user } = renderWithQuery(<CompliancePage />);
    await user.click(await screen.findByRole('button', { name: 'Fail — take offline…' }));
    const dialog = screen.getByRole('dialog', { name: "Fail Ben Driver's re-verification and take them offline?" });
    await user.type(within(dialog).getByRole('textbox', { name: 'Reason' }), REASON);
    await user.click(within(dialog).getByRole('button', { name: 'Fail and take offline' }));
    expect(within(dialog).getByText('Enter what is wrong.')).toBeTruthy();
    expect(requestsByMethod(fetchMock, 'POST')).toHaveLength(0);
    await user.type(within(dialog).getByRole('textbox', { name: 'What is wrong' }), 'Insurance certificate is a copy of last year’s');
    await user.click(within(dialog).getByRole('button', { name: 'Fail and take offline' }));
    await waitFor(() => expect(requestsByMethod(fetchMock, 'POST')).toHaveLength(1));
    const [url, init] = requestsByMethod(fetchMock, 'POST')[0]!;
    expect(String(url)).toContain('/api/v1/admin/compliance/reviews/c1/decide');
    expect(JSON.parse(String(init?.body))).toEqual({ pass: false, note: 'Insurance certificate is a copy of last year’s' });
    expect(reasonOf(init)).toBe(REASON);
    expect((await screen.findByRole('status')).textContent).toContain('Ben Driver failed re-verification and is offline.');
  });

  it('"their checklist still fails" is shown — the old page swallowed it — and phones are masked', async () => {
    forbidBrowserPrompts();
    server(() => ({ status: 409, body: { success: false, error: { code: 'STILL_FAILING', message: 'Their checklist still fails: insurance expired.' } } }));
    const { user } = renderWithQuery(<CompliancePage />);
    expect(await screen.findByText('••• ••• 1222')).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/\+5926111222|\+5926333444/);
    await user.click(screen.getByRole('button', { name: 'Mark resolved…' }));
    const dialog = await answer(user, "Mark Ana Mover's violation resolved?", 'Mark resolved');
    expect((await within(dialog).findByRole('alert')).textContent).toContain('Their checklist still fails: insurance expired.');
  });

  it('an audit run says what it found', async () => {
    forbidBrowserPrompts();
    server(() => ({ body: { success: true, data: { id: 'run1', moversChecked: 42, violations: 0 } } }));
    const { user } = renderWithQuery(<CompliancePage />);
    await user.click(await screen.findByRole('button', { name: 'Run audit now' }));
    expect((await screen.findByRole('status')).textContent).toContain('Audit finished: 42 online movers checked, 0 violations.');
  });
});

describe('[MC-PR3b] broadcast', () => {
  it('one panel shows the message and the audience, says it cannot be recalled, asks why — and a queued send is said as queued', async () => {
    forbidBrowserPrompts();
    const fetchMock = mockApi(() => queued);
    const { user } = renderWithQuery(<BroadcastPage />);
    await user.selectOptions(screen.getByLabelText('Audience'), 'CUSTOMER');
    await user.type(screen.getByLabelText('Title (max 150)'), 'Service update');
    await user.type(screen.getByLabelText('Message (max 1000)'), 'Deliveries resume at noon.');
    await user.click(screen.getByRole('button', { name: 'Send to Customers…' }));
    const dialog = screen.getByRole('dialog', { name: 'Send this to Customers?' });
    expect(dialog.textContent).toContain('Deliveries resume at noon.');
    expect(dialog.textContent).toContain('cannot be recalled');
    expect(requestsByMethod(fetchMock, 'POST')).toHaveLength(0);
    await answer(user, 'Send this to Customers?', 'Send broadcast');
    const [, init] = requestsByMethod(fetchMock, 'POST')[0]!;
    expect(JSON.parse(String(init?.body))).toEqual({ title: 'Service update', body: 'Deliveries resume at noon.', category: 'service', role: 'CUSTOMER' });
    expect(reasonOf(init)).toBe(REASON);
    expect((await screen.findByRole('status')).textContent).toContain("Sent for a second admin's approval");
    // the draft is cleared, so the same message is not sent twice
    expect((screen.getByLabelText('Title (max 150)') as HTMLInputElement).value).toBe('');
  });

  it('cancelling the panel sends nothing and keeps the draft', async () => {
    forbidBrowserPrompts();
    const fetchMock = mockApi(() => queued);
    const { user } = renderWithQuery(<BroadcastPage />);
    await user.type(screen.getByLabelText('Title (max 150)'), 'Service update');
    await user.type(screen.getByLabelText('Message (max 1000)'), 'Deliveries resume at noon.');
    await user.click(screen.getByRole('button', { name: /^Send to Everyone/ }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }));
    expect(requestsByMethod(fetchMock, 'POST')).toHaveLength(0);
    expect((screen.getByLabelText('Title (max 150)') as HTMLInputElement).value).toBe('Service update');
  });
});

describe('[MC-PR3b] promo codes', () => {
  it('creating one asks why in the page and says it went for approval; the form closes', async () => {
    forbidBrowserPrompts();
    const fetchMock = mockApi((r: ApiRequest) => (r.method === 'GET' ? { body: { success: true, data: [] } } : queued));
    const { user } = renderWithQuery(<PromosPage />);
    await user.click(await screen.findByRole('button', { name: /create promo/i }));
    await user.type(screen.getByLabelText('Code'), 'welcome10');
    await user.type(screen.getByLabelText('Description'), '10% off your first order');
    await user.click(screen.getByRole('button', { name: 'Create…' }));
    await answer(user, 'Create promo code WELCOME10?', 'Send for approval');
    const [, init] = requestsByMethod(fetchMock, 'POST')[0]!;
    expect(JSON.parse(String(init?.body))).toMatchObject({ code: 'WELCOME10', description: '10% off your first order' });
    expect(reasonOf(init)).toBe(REASON);
    expect((await screen.findByRole('status')).textContent).toContain("Sent for a second admin's approval");
    expect(screen.queryByLabelText('Code')).toBeNull();
  });
});

describe('[MC-PR3b] discovery merge', () => {
  const cat = (id: string, name: string) => ({ id, name, slug: id, kind: 'CUISINE', vertical: 'FOOD', aliases: [], status: 'ACTIVE', mergedIntoId: null, emoji: '' });
  it('names both categories, asks why, and shows the answer', async () => {
    forbidBrowserPrompts();
    const fetchMock = mockApi((r: ApiRequest) => {
      if (r.method === 'GET' && r.url.pathname.endsWith('/discovery/categories')) return { body: { success: true, data: [cat('c1', 'Roti'), cat('c2', 'Caribbean')] } };
      if (r.method === 'GET') return { body: { success: true, data: [] } };
      return { body: { success: true, data: { dedupes: {} } } };
    });
    const { user } = renderWithQuery(<DiscoveryPage />);
    await user.click(await screen.findByRole('button', { name: 'Taxonomy' }));
    await user.selectOptions(await screen.findByRole('combobox', { name: 'Merge Roti into' }), 'c2');
    await answer(user, 'Merge Roti into Caribbean?', 'Merge categories');
    const [url, init] = requestsByMethod(fetchMock, 'POST')[0]!;
    expect(String(url)).toContain('/discovery/categories/c1/merge-into');
    expect(JSON.parse(String(init?.body))).toEqual({ targetId: 'c2' });
    expect(reasonOf(init)).toBe(REASON);
    expect((await screen.findByRole('status')).textContent).toContain('Roti is merged into Caribbean.');
  });
});

describe('[MC-PR3b] moderation', () => {
  it('a cancelled reason panel decides nothing', async () => {
    forbidBrowserPrompts();
    const fetchMock = mockApi((r: ApiRequest) => (r.url.pathname.endsWith('/ratings/moderation')
      ? { body: { success: true, data: { reports: [], held: [{ id: 'held-1', score: 1, comment: 'held by the filter', createdAt: '2026-10-01T00:00:00Z' }] } } }
      : { body: { success: true, data: [], pendingTotal: 0 } }));
    const { user } = renderWithQuery(<ModerationPage />);
    await user.click(await screen.findByRole('button', { name: /Held reviews/ }));
    await user.click(await screen.findByRole('button', { name: 'Remove' }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(requestsByMethod(fetchMock, 'POST')).toHaveLength(0);
  });
});
