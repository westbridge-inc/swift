import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithQuery } from '@/test/test-utils';
import * as feeApi from '@/lib/store-fee-api';
import { GO_LIVE_STEPS } from '@/lib/branch-go-live';
import { StoreFeeCard } from './store-fee-card';

// ---------------------------------------------------------------------------
// [RETIER PR-A2 · owner 30 Oct 2026] A store whose weekly fee follows its catalogue above the first step goes live only
// after its owner reads that exact fee and ticks it. The figure, why and the words are the server's; the card sends
// back exactly what it showed. Synthetic figures only.
// ---------------------------------------------------------------------------

const TERMS = { version: 'v1', items: [{ heading: 'What it covers', text: 'The Swift app and its tools for your work.' }], tick: 'I understand the weekly fee.' };
const view = (over: Partial<feeApi.StoreFeeView> = {}): feeApi.StoreFeeView => ({
  vendorId: 'store-2', set: false, required: true, ticked: false, why: 'It has 10,000 items for sale, so it is on the department store rate.',
  weeklyFee: { amount: 45000, currencyCode: 'GYD', tier: 'department', version: 'v1' }, terms: TERMS, ...over,
});

afterEach(() => vi.restoreAllMocks());
const settled = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });

describe('[RETIER PR-A2] the store weekly-fee card', () => {
  it('shows the exact fee, why and the words; the button waits for the tick, then sends exactly that fee', async () => {
    vi.spyOn(feeApi, 'getStoreFee').mockResolvedValue(view());
    const sent = vi.spyOn(feeApi, 'tickStoreFee').mockResolvedValue({} as never);
    renderWithQuery(<StoreFeeCard storeId="store-2" isOwner />);
    expect(await screen.findByText('Your weekly fee: GYD 45,000 a week')).toBeTruthy();
    expect(screen.getByText(/10,000 items for sale/)).toBeTruthy();
    expect(screen.getByText(/The Swift app and its tools/)).toBeTruthy();
    const box = screen.getByRole('checkbox', { name: TERMS.tick });
    const button = screen.getByRole('button', { name: 'Confirm' });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(box);
    fireEvent.click(button);
    await waitFor(() => expect(sent).toHaveBeenCalledWith({ version: 'v1', amount: 45000, currencyCode: 'GYD' }));
  });

  it('nothing to tick (not required, already ticked, fee set, other words) or a manager: no card', async () => {
    for (const v of [view({ required: false }), view({ ticked: true }), view({ set: true, required: false, weeklyFee: null }), view({ terms: { ...TERMS, version: 'v2' } })]) {
      vi.spyOn(feeApi, 'getStoreFee').mockResolvedValue(v);
      const { unmount } = renderWithQuery(<StoreFeeCard storeId="store-2" isOwner />);
      await settled();
      expect(screen.queryByRole('checkbox')).toBeNull();
      unmount();
    }
    vi.restoreAllMocks();
    const read = vi.spyOn(feeApi, 'getStoreFee').mockResolvedValue(view());
    renderWithQuery(<StoreFeeCard storeId="store-2" isOwner={false} />);
    await settled();
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(read).not.toHaveBeenCalled();
  });

  it('the go-live step points the owner to Settings', () => {
    expect(GO_LIVE_STEPS['WEEKLY_FEE']).toEqual({ words: 'Read and tick its weekly fee', where: 'settings' });
  });
});
