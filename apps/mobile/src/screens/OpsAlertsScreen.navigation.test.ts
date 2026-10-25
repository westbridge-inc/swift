/// <reference lib="dom" />
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
// @ts-expect-error react-dom is deliberately not a mobile runtime dependency.
import { createRoot } from 'react-dom/client';

// ---------------------------------------------------------------------------
// [DRILL-STORM · S-19] A responder taps a page on the phone and acknowledges it.
// The REAL OpsAlertsScreen on a real React renderer; native drawing, the kit and
// the network hooks are stand-ins. Asserted: the tapped page comes first with
// its words (kind, opened, overdue, re-paged), an SOS says acknowledging does
// not close it; Acknowledge asks first, then acknowledges THAT page once and
// says the re-pages stopped; a lost race says "Already handled"; a person who
// is not a responder is told so in words (never "nothing is waiting"); a read
// that failed is a failure with a retry, never an empty list.
// ---------------------------------------------------------------------------

type Row = { id: string; kind: string; title: string; body: string; createdAt: string; ackDeadlineAt: string; escalationLevel: number };
const fx = vi.hoisted(() => ({
  route: { name: 'OpsAlerts', params: {} as Record<string, unknown> | undefined },
  query: {} as { isLoading?: boolean; isError?: boolean; error?: unknown; data?: Row[]; dataUpdatedAt?: number; refetch: () => void },
  mutate: vi.fn(),
  isPending: false,
  variables: undefined as string | undefined,
  token: new Proxy({}, { get: (_target, key): unknown => key === Symbol.toPrimitive ? () => 0 : fx.token }),
}));

vi.mock('react-native', async () => {
  const R = await import('react');
  return {
    View: (p: any) => R.createElement('div', null, p.children),
    ScrollView: (p: any) => R.createElement('div', null, p.children),
  };
});
vi.mock('@react-navigation/native', () => ({ useRoute: () => fx.route, useNavigation: () => ({ goBack: vi.fn() }) }));
vi.mock('@swift/ui', () => ({ space: fx.token, color: fx.token }));
vi.mock('../kit', async () => {
  const R = await import('react');
  const h = R.createElement;
  return {
    Screen: (p: any) => h('main', null, p.children),
    Header: (p: any) => h('header', null, p.title),
    T: (p: any) => h('span', null, p.children),
    Card: (p: any) => h('section', { 'aria-label': p.accessibilityLabel }, p.children),
    PillButton: (p: any) => h('button', { type: 'button', onClick: p.onPress, 'data-loading': p.loading ? '1' : '0' }, p.label),
    LoadingBlock: () => h('p', null, 'Loading'),
    ErrorState: (p: any) => h('div', { role: 'alert' }, p.message, p.onRetry ? h('button', { type: 'button', onClick: p.onRetry }, 'Try again') : null),
    EmptyState: (p: any) => h('div', { 'data-empty': '1' }, h('strong', null, p.title), p.body ? h('span', null, p.body) : null),
    ConfirmDialog: (p: any) => (p.open ? h('dialog', { open: true, 'aria-label': p.title }, h('p', null, p.body), h('button', { type: 'button', onClick: p.onConfirm }, p.confirmLabel), h('button', { type: 'button', onClick: p.onClose }, 'Cancel')) : null),
  };
});
vi.mock('../hooks/opsAlerts', () => ({
  useOpsAlerts: () => fx.query,
  useAcknowledgeOpsAlert: () => ({ mutate: fx.mutate, isPending: fx.isPending, variables: fx.variables }),
}));

import { OpsAlertsScreen } from './OpsAlertsScreen';

const SOS: Row = { id: 'ops-sos', kind: 'SOS', title: 'URGENT: SOS ACTIVE', body: 'A rider pressed SOS on order SW-1001.', createdAt: '2026-10-25T16:00:00.000Z', ackDeadlineAt: '2026-10-25T16:02:00.000Z', escalationLevel: 2 };
const DRILL: Row = { id: 'ops-drill', kind: 'DRILL', title: 'Ops alert drill — acknowledge now', body: 'This is a scheduled drill of the SOS paging path.', createdAt: '2026-10-25T15:00:00.000Z', ackDeadlineAt: '2026-10-25T15:02:00.000Z', escalationLevel: 0 };
const NOW = Date.parse('2026-10-25T16:30:00.000Z');

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const render = async () => { await act(async () => root.render(React.createElement(OpsAlertsScreen))); };
const click = async (label: string, within: ParentNode = host) => {
  const b = Array.from(within.querySelectorAll('button')).find((x) => x.textContent === label);
  if (!b) throw new Error(`no button "${label}" in: ${host.textContent}`);
  await act(async () => { b.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); });
};
const cards = () => Array.from(host.querySelectorAll('section')).map((s) => s.getAttribute('aria-label'));

beforeEach(() => {
  vi.clearAllMocks();
  fx.route = { name: 'OpsAlerts', params: { opsAlertId: 'ops-drill' } };
  fx.query = { data: [SOS, DRILL], dataUpdatedAt: NOW, refetch: vi.fn() };
  fx.isPending = false; fx.variables = undefined;
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

describe('[DRILL-STORM] a responder acknowledges a page on the phone', () => {
  it('opens at the page they tapped, then SOS pages; each page says what it is, when it opened, overdue, re-paged', async () => {
    await render();
    expect(cards()).toEqual(['Ops alert drill — acknowledge now', 'URGENT: SOS ACTIVE']);
    const sos = host.querySelector('section[aria-label="URGENT: SOS ACTIVE"]')!;
    expect(sos.textContent).toContain('SOS · opened 25 Oct, 12:00 pm · overdue · re-paged 2 times');
    expect(sos.textContent).toContain('A rider pressed SOS on order SW-1001.');
    expect(sos.textContent).toContain('Acknowledging does not close the SOS');
    expect(host.querySelector('section[aria-label="Ops alert drill — acknowledge now"]')!.textContent).not.toContain('does not close the SOS');
  });

  it('asks first, then acknowledges THAT page once and says the re-pages stopped', async () => {
    fx.mutate.mockImplementation((_id, cb) => { cb.onSuccess({ acknowledged: true }); cb.onSettled?.(); });
    await render();
    const drill = host.querySelector('section[aria-label="Ops alert drill — acknowledge now"]')!;
    await click('Acknowledge', drill);
    expect(fx.mutate).not.toHaveBeenCalled();
    const dialog = host.querySelector('dialog')!;
    expect(dialog.getAttribute('aria-label')).toBe('Acknowledge this page?');
    expect(dialog.textContent).toContain('Swift stops re-paging everyone about it');
    await click('Acknowledge', dialog);
    expect(fx.mutate).toHaveBeenCalledTimes(1);
    expect(fx.mutate.mock.calls[0]![0]).toBe('ops-drill');
    expect(host.textContent).toContain('Acknowledged: Ops alert drill — acknowledge now. The re-pages have stopped.');
    expect(host.querySelector('dialog')).toBeNull();
  });

  it('a page someone else acknowledged first says so, never that this person stopped it', async () => {
    fx.mutate.mockImplementation((_id, cb) => { cb.onSuccess({ acknowledged: false }); cb.onSettled?.(); });
    await render();
    await click('Acknowledge', host.querySelector('section')!);
    await click('Acknowledge', host.querySelector('dialog')!);
    expect(host.textContent).toContain('Already handled: someone acknowledged it first, or it was closed.');
    expect(host.textContent).not.toContain('The re-pages have stopped');
  });

  it('a refused acknowledgement is said in words', async () => {
    fx.mutate.mockImplementation((_id, cb) => { cb.onError({ response: { status: 403 } }); cb.onSettled?.(); });
    await render();
    await click('Acknowledge', host.querySelector('section')!);
    await click('Acknowledge', host.querySelector('dialog')!);
    expect(host.textContent).toContain('Only Swift operations staff can acknowledge this page.');
  });

  it('someone who is not a responder is told so in words — never "nothing is waiting"', async () => {
    fx.query = { isError: true, error: { response: { status: 403 } }, refetch: vi.fn() };
    await render();
    expect(host.textContent).toContain('For Swift operations staff');
    expect(host.textContent).not.toContain('Nothing is waiting');
    expect(host.querySelector('button')).toBeNull();
  });

  it('a read that failed is a failure with a retry, never an empty list', async () => {
    fx.query = { isError: true, error: new Error('Network Error'), refetch: vi.fn() };
    await render();
    expect(host.querySelector('[role="alert"]')).not.toBeNull();
    expect(host.textContent).not.toContain('Nothing is waiting');
    await click('Try again');
    expect(fx.query.refetch).toHaveBeenCalledTimes(1);
  });

  it('nothing waiting: says so, and that the page they opened was already handled', async () => {
    fx.query = { data: [], dataUpdatedAt: NOW, refetch: vi.fn() };
    await render();
    expect(host.textContent).toContain('Nothing is waiting for acknowledgement');
    expect(host.textContent).toContain('The page you opened was already acknowledged by someone, or it was closed.');
  });
});
