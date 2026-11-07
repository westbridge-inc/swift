/// <reference lib="dom" />
import { afterEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
// @ts-expect-error The workspace web install supplies the test renderer.
import { createRoot } from 'react-dom/client';

// [BOOK-P3 · owner B2] "Change time" / "Move booking" on a job booked from a pro's list: the times are the
// server's PER-JOB list (its booked length, its own time not counted), the move sends the job's generation,
// and a refusal is shown in the server's words. The transport hooks are stand-ins; the card is real.
const fx = vi.hoisted(() => ({
  move: vi.fn(),
  pending: false,
  slots: { data: { slots: [] as string[], bookableWeekdays: [0, 1, 2, 3, 4, 5, 6], horizonDays: 366 }, isPending: false, isError: false, refetch: vi.fn() } as Record<string, unknown>,
  asked: [] as Array<[string, string]>,
}));
vi.mock('react-native', async () => {
  const { createElement: h } = await import('react');
  const Box = (p: any) => h('div', null, p.children);
  return { View: Box, ScrollView: Box };
});
vi.mock('../../kit', async () => {
  const { createElement: h } = await import('react');
  const Box = (p: any) => h('div', null, p.children);
  const Button = (p: any) => h('button', { disabled: p.disabled || p.loading, onClick: p.onPress }, p.label);
  return { T: Box, PillButton: Button, Chip: Button };
});
vi.mock('../../hooks', () => ({
  useJobSlots: (jobId: string, day: string) => { fx.asked.push([jobId, day]); return fx.slots; },
  useRescheduleServiceJob: () => ({ mutate: fx.move, isPending: fx.pending }),
}));

import { ProJobMoveCard } from './ProJobMoveCard';

let root: ReturnType<typeof createRoot> | undefined;
let host: HTMLDivElement;
afterEach(async () => {
  if (root) await act(async () => root.unmount());
  host?.remove(); root = undefined; fx.move.mockReset(); fx.pending = false; fx.asked = [];
  fx.slots = { data: { slots: [], bookableWeekdays: [0, 1, 2, 3, 4, 5, 6], horizonDays: 366 }, isPending: false, isError: false, refetch: vi.fn() };
});

const CURRENT = '2026-12-01T14:00:00.000Z'; // 10:00 AM in Guyana
const OTHER = '2026-12-01T16:00:00.000Z'; // 12:00 PM in Guyana
const JOB = { id: 'job-1', scheduledFor: CURRENT, updatedAt: '2026-11-20T10:00:00.000Z' };
async function render(isCustomer: boolean) {
  host = document.createElement('div'); document.body.append(host);
  root = createRoot(host);
  await act(async () => root!.render(React.createElement(ProJobMoveCard, { job: JOB, isCustomer })));
}
const button = (label: string) => [...host.querySelectorAll('button')].find((b) => b.textContent === label);
const confirmButton = () => [...host.querySelectorAll('button')].find((b) => b.textContent?.startsWith('Move to '));

describe('[BOOK-P3] moving a job booked from a pro\'s list', () => {
  it('closed: no read; open: the per-job times of the booked day, and the move with the job\'s generation', async () => {
    fx.slots = { ...fx.slots, data: { slots: [OTHER], bookableWeekdays: [0, 1, 2, 3, 4, 5, 6], horizonDays: 366 } };
    await render(true);
    expect(fx.asked.every(([jobId]) => jobId === '')).toBe(true);
    await act(async () => button('Change time')!.click());
    expect(fx.asked.at(-1)).toEqual(['job-1', '2026-12-01']);
    expect(button('Pick a new time')!.disabled).toBe(true);
    await act(async () => button('12:00 PM')!.click());
    expect(confirmButton()!.textContent).toContain('12:00 PM');
    await act(async () => confirmButton()!.click());
    expect(fx.move.mock.calls[0]![0]).toEqual({ id: 'job-1', scheduledFor: OTHER, expectedUpdatedAt: JOB.updatedAt, expectedScheduledFor: CURRENT });
  });

  it('the pro reads "Move booking" and is told the customer hears of it', async () => {
    await render(false);
    await act(async () => button('Move booking')!.click());
    expect(host.textContent).toContain('The customer is told in the app.');
  });

  it('a refused move shows the server\'s words, lets the time go, and a taken time reloads the list', async () => {
    fx.slots = { ...fx.slots, data: { slots: [OTHER], bookableWeekdays: [0, 1, 2, 3, 4, 5, 6], horizonDays: 366 } };
    fx.move.mockImplementation((_v: unknown, opts: { onError: (e: unknown) => void }) => opts.onError({ response: { data: { error: { code: 'SLOT_TAKEN', message: 'That time was just booked with this provider — pick another time' } } } }));
    await render(true);
    await act(async () => button('Change time')!.click());
    await act(async () => button('12:00 PM')!.click());
    await act(async () => confirmButton()!.click());
    expect(host.textContent).toContain('That time was just booked with this provider — pick another time');
    expect(button('Pick a new time')!.disabled).toBe(true);
    expect(fx.slots['refetch']).toHaveBeenCalled();
  });

  it('a refused read (the cut-off for the customer) is the server\'s words with a retry, never "no times"', async () => {
    fx.slots = { data: undefined, isPending: false, isError: true, error: { response: { data: { error: { message: 'This booking can no longer be moved in the app: it starts in less than 2 hours. Contact the provider to change it.' } } } }, refetch: vi.fn() };
    await render(true);
    await act(async () => button('Change time')!.click());
    expect(host.textContent).toContain('it starts in less than 2 hours');
    expect(host.textContent).not.toContain('No other times');
  });
});
