/// <reference lib="dom" />
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
// @ts-expect-error react-dom is deliberately not a mobile runtime dependency.
import { createRoot } from 'react-dom/client';

// ---------------------------------------------------------------------------
// [UI-SWEEP U10 · REVIEW-F #1902 S3-1] A tap to a screen already in the stack
// goes BACK to that screen (navigate + pop) and hands it the NEW params. React
// Navigation keeps the same mounted screen, so a form seeded once from its
// params kept the old door's typing: a ticket typed for order A was filed
// against order B. The REAL GetHelpScreen on a real React renderer; the route
// object is what React Navigation passes to the reused screen. Only native
// drawing, the kit and the network are stand-ins.
// ---------------------------------------------------------------------------

const fx = vi.hoisted(() => ({
  route: { name: 'GetHelp', params: {} as Record<string, unknown> | undefined },
  create: vi.fn(),
  token: new Proxy({}, { get: (_target, key): unknown => key === Symbol.toPrimitive ? () => 0 : fx.token }),
}));

vi.mock('react-native', async () => {
  const R = await import('react');
  const View = (p: any) => R.createElement('div', null, p.children);
  return { View, ScrollView: View };
});
vi.mock('@react-navigation/native', () => ({ useRoute: () => fx.route }));
vi.mock('@swift/ui', () => ({ color: fx.token, radius: fx.token, space: fx.token }));
vi.mock('../../../kit', async () => {
  const R = await import('react');
  const h = R.createElement;
  const Box = (p: any) => h('div', null, p.children);
  return {
    Card: Box, Screen: Box, Header: (p: any) => h('header', null, p.title), TonePill: () => null,
    T: (p: any) => h('span', null, p.children),
    Chip: (p: any) => h('button', { type: 'button', 'aria-pressed': p.selected ? 'true' : 'false', onClick: p.onPress }, p.label),
    LabeledInput: (p: any) => h('input', {
      'aria-label': p.placeholder, value: p.value, onChange: (e: any) => p.onChangeText(e.target.value),
    }),
    PillButton: (p: any) => h('button', { type: 'button', 'data-pill': 'true', disabled: !!p.disabled, onClick: p.disabled ? undefined : p.onPress }, p.label),
  };
});
vi.mock('../../../hooks', () => ({
  useCreateTicket: () => ({ mutate: fx.create, isPending: false }),
  useMySupportTickets: () => ({ data: [] }),
}));
vi.mock('../../../kit/toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { GetHelpScreen } from './GetHelpScreen';

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

const input = (placeholder: string) => host.querySelector<HTMLInputElement>(`input[aria-label="${placeholder}"]`)!;
const selectedTopic = () => host.querySelector('button[aria-pressed="true"]')?.textContent;
const submitButton = () => host.querySelector<HTMLButtonElement>('button[data-pill="true"]')!;
async function type(placeholder: string, value: string) {
  const el = input(placeholder);
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')!.set!;
  await act(async () => {
    setter.call(el, value);
    el.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
}
/** React Navigation re-renders the SAME mounted screen with the new route (navigate + pop). */
async function reuseWith(params: Record<string, unknown> | undefined) {
  fx.route = { ...fx.route, params };
  await act(async () => root.render(React.createElement(GetHelpScreen)));
}

beforeEach(async () => {
  vi.clearAllMocks();
  fx.route = { name: 'GetHelp', params: { orderId: 'order-A' } };
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(async () => root.render(React.createElement(GetHelpScreen)));
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

describe('[UI-SWEEP U10 S3-1] Get help, reused for another door, starts from that door', () => {
  it('typing for order A never reaches a ticket filed against order B', async () => {
    await type('Short summary', 'Cold food on A');
    await type('Tell us what happened…', 'The rice from order A arrived cold.');
    await act(async () => host.querySelectorAll('button')[2]!.dispatchEvent(new window.MouseEvent('click', { bubbles: true })));
    expect(selectedTopic()).toBe('Safety');

    await reuseWith({ orderId: 'order-B' });

    expect(input('Short summary').value, 'order A’s summary is gone').toBe('');
    expect(input('Tell us what happened…').value, 'order A’s message is gone').toBe('');
    expect(selectedTopic(), 'the topic is order B’s door default').toBe('Order issue');
    expect(submitButton().disabled, 'nothing can be filed until B is described').toBe(true);

    await type('Short summary', 'Missing item on B');
    await type('Tell us what happened…', 'Order B came without the drink.');
    await act(async () => submitButton().dispatchEvent(new window.MouseEvent('click', { bubbles: true })));
    expect(fx.create).toHaveBeenCalledTimes(1);
    expect(fx.create.mock.calls[0]![0]).toEqual({
      category: 'ORDER_ISSUE', subject: 'Missing item on B', message: 'Order B came without the drink.', orderId: 'order-B',
    });
  });

  it('a half-written appeal door is seeded again when it is reused for another document', async () => {
    await reuseWith({ category: 'ACCOUNT', subject: 'Licence appeal', message: 'Reviewer said: blurry.' });
    await type('Tell us what happened…', 'Reviewer said: blurry. I re-took the photo.');
    await reuseWith({ category: 'ACCOUNT', subject: 'Insurance appeal', message: 'Reviewer said: expired.' });
    expect(input('Short summary').value).toBe('Insurance appeal');
    expect(input('Tell us what happened…').value).toBe('Reviewer said: expired.');
  });

  it('the SAME door handed again keeps what the person typed (no reset without a new id)', async () => {
    await type('Short summary', 'Cold food on A');
    await reuseWith({ orderId: 'order-A' });
    expect(input('Short summary').value).toBe('Cold food on A');
  });
});
