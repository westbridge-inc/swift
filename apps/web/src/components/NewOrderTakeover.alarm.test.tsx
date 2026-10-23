import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import NewOrderTakeover from './NewOrderTakeover';
import { renderWithQuery, stubAudioContext } from '@/test/test-utils';
import { wireVendorOrder } from '@/test/vendor-wire-fixtures';
import { normalizeVendorOrder } from '@/lib/vendor-api';

// ---------------------------------------------------------------------------
// [STORE-DASH · owner 22 Oct 2026 "new orders impossible to miss"]
//   1. An order still waiting when the page opens takes the screen too (the
//      first read used to only note it, so after a reload it waited silently).
//      An order whose answer clock already ran out stays on the board only.
//   2. A browser keeps a page silent until it is pressed once (every reload).
//      The page's first press or key wakes the sound; while it is still off,
//      the takeover says so and offers the press.
//   3. The tab title keeps the count of orders waiting after "View later".
// ---------------------------------------------------------------------------

const order = (over: Record<string, unknown> = {}) => normalizeVendorOrder(wireVendorOrder(over));
const later = () => new Date(Date.now() + 5 * 60_000).toISOString();
const earlier = () => new Date(Date.now() - 60_000).toISOString();

/** A sound context the browser has not unlocked yet; resume() unlocks it. */
function suspendedAudio() {
  const made: Array<{ state: string; resume: ReturnType<typeof vi.fn>; onstatechange: null | (() => void) }> = [];
  stubAudioContext();
  const Base = (globalThis as unknown as { AudioContext: new () => object }).AudioContext;
  vi.stubGlobal('AudioContext', class extends (Base as new () => Record<string, unknown>) {
    state = 'suspended';
    onstatechange: null | (() => void) = null;
    resume = vi.fn(async () => { this.state = 'running'; this.onstatechange?.(); });
    constructor() { super(); made.push(this as never); }
  });
  return made;
}

let baseTitle = '';
beforeEach(() => { baseTitle = 'Orders — Swift Business'; document.title = baseTitle; });
afterEach(() => { vi.unstubAllGlobals(); });

describe('[STORE-DASH] an order waiting at page open is not missed', () => {
  beforeEach(() => { stubAudioContext(); });

  it('the first read shows an order still waiting for an answer', async () => {
    renderWithQuery(<NewOrderTakeover orders={[order({ respondBy: later() })]} />);
    expect(await screen.findByText(/NEW ORDER/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Accept' })).toBeTruthy();
  });

  it('an order with no answer clock from the server is still waiting', async () => {
    renderWithQuery(<NewOrderTakeover orders={[order({ respondBy: null })]} />);
    expect(await screen.findByText(/NEW ORDER/)).toBeTruthy();
  });

  it('control: an order whose answer clock already ran out stays on the board only', async () => {
    renderWithQuery(<NewOrderTakeover orders={[order({ respondBy: earlier() })]} />);
    await act(async () => {});
    expect(screen.queryByText(/NEW ORDER/)).toBeNull();
  });

  it('control: an order already answered at open is never shown', async () => {
    renderWithQuery(<NewOrderTakeover orders={[order({ status: 'PREPARING' })]} />);
    await act(async () => {});
    expect(screen.queryByText(/NEW ORDER/)).toBeNull();
  });
});

describe('[STORE-DASH] the sound the browser keeps off', () => {
  it('while the sound is off the takeover says so; one press turns it on', async () => {
    const made = suspendedAudio();
    renderWithQuery(<NewOrderTakeover orders={[order({ respondBy: later() })]} />);
    const turnOn = await screen.findByRole('button', { name: 'Sound is off — tap to hear new orders' });
    await act(async () => { fireEvent.click(turnOn); });
    expect(made[0]!.resume).toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Sound is off — tap to hear new orders' })).toBeNull());
  });

  it('the page\'s first press wakes the sound before any order arrives', async () => {
    const made = suspendedAudio();
    renderWithQuery(<NewOrderTakeover orders={[]} />);
    await act(async () => { fireEvent.pointerDown(window); });
    expect(made.length).toBe(1);
    expect(made[0]!.resume).toHaveBeenCalled();
  });

  it('control: with the sound already on there is no such button', async () => {
    stubAudioContext();
    renderWithQuery(<NewOrderTakeover orders={[order({ respondBy: later() })]} />);
    await screen.findByText(/NEW ORDER/);
    expect(screen.queryByRole('button', { name: /Sound is off/ })).toBeNull();
  });
});

describe('[STORE-DASH] the tab title keeps the count', () => {
  beforeEach(() => { stubAudioContext(); });

  it('after "View later" the title still says an order is waiting, and clears when it is answered', async () => {
    const waiting = order({ respondBy: later() });
    const view = renderWithQuery(<NewOrderTakeover orders={[waiting]} />);
    await view.user.click(await screen.findByText(/View later/));
    await waitFor(() => expect(document.title).toBe(`(1) order waiting — ${baseTitle}`));
    view.rerender(<NewOrderTakeover orders={[order({ status: 'PREPARING' })]} />);
    await waitFor(() => expect(document.title).toBe(baseTitle));
  });

  it('two waiting: "(2) orders waiting"', async () => {
    const view = renderWithQuery(<NewOrderTakeover orders={[]} />);
    view.rerender(<NewOrderTakeover orders={[order({ id: 'a', respondBy: later() }), order({ id: 'b', orderNumber: 'SW-1002', respondBy: later() })]} />);
    await view.user.click(await screen.findByText(/View later/));
    await view.user.click(await screen.findByText(/View later/));
    await waitFor(() => expect(document.title).toBe(`(2) orders waiting — ${baseTitle}`));
  });
});
