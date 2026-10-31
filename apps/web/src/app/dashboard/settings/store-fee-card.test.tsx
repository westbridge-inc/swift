import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithQuery } from '@/test/test-utils';
import * as feeApi from '@/lib/store-fee-api';
import { GO_LIVE_STEPS } from '@/lib/branch-go-live';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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
    const read = vi.spyOn(feeApi, 'getStoreFee').mockResolvedValue(view());
    const sent = vi.spyOn(feeApi, 'tickStoreFee').mockResolvedValue({} as never);
    renderWithQuery(<StoreFeeCard storeId="store-2" isOwner />);
    expect(await screen.findByText('Your weekly fee: GY$45,000 a week')).toBeTruthy();
    expect(screen.getByText(/10,000 items for sale/)).toBeTruthy();
    expect(screen.getByText(/The Swift app and its tools/)).toBeTruthy();
    const box = screen.getByRole('checkbox', { name: TERMS.tick });
    const button = screen.getByRole('button', { name: 'Confirm' });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(box);
    fireEvent.click(button);
    await waitFor(() => expect(sent).toHaveBeenCalledWith({ vendorId: 'store-2', weeklyFeeAck: { version: 'v1', amount: 45000, currencyCode: 'GYD' } }));
    expect(read).toHaveBeenCalledWith('store-2');
  });

  it('a fee that changes after the box was ticked empties the box: the new amount must be ticked itself', async () => {
    const read = vi.spyOn(feeApi, 'getStoreFee').mockResolvedValue(view());
    const sent = vi.spyOn(feeApi, 'tickStoreFee').mockResolvedValue({} as never);
    const { queryClient } = renderWithQuery(<StoreFeeCard storeId="store-2" isOwner />);
    fireEvent.click(await screen.findByRole('checkbox', { name: TERMS.tick }));
    expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(true);
    read.mockResolvedValue(view({ weeklyFee: { amount: 20000, currencyCode: 'GYD', tier: 'large', version: 'v1' } }));
    await act(async () => { await queryClient.invalidateQueries(); });
    await screen.findByText('Your weekly fee: GY$20,000 a week');
    expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(false);
    expect((screen.getByRole('button', { name: 'Confirm' }) as HTMLButtonElement).disabled).toBe(true);
    expect(sent).not.toHaveBeenCalled();
  });

  it('a refused save empties the box', async () => {
    vi.spyOn(feeApi, 'getStoreFee').mockResolvedValue(view());
    vi.spyOn(feeApi, 'tickStoreFee').mockRejectedValue(new Error('The weekly fee for this choice is GYD 20,000 a week.'));
    renderWithQuery(<StoreFeeCard storeId="store-2" isOwner />);
    fireEvent.click(await screen.findByRole('checkbox', { name: TERMS.tick }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(false);
  });

  it('an answer about another store shows nothing', async () => {
    vi.spyOn(feeApi, 'getStoreFee').mockResolvedValue(view({ vendorId: 'store-9' }));
    renderWithQuery(<StoreFeeCard storeId="store-2" isOwner />);
    await settled();
    expect(screen.queryByRole('checkbox')).toBeNull();
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

  it('[REVIEW-F S3-1] a failed read says it could not be loaded, with Retry, never nothing; Retry reads again', async () => {
    const read = vi.spyOn(feeApi, 'getStoreFee').mockRejectedValue(new Error('Network down'));
    renderWithQuery(<StoreFeeCard storeId="store-2" isOwner />);
    expect(await screen.findByText(/Couldn.t load your weekly fee/)).toBeTruthy();
    read.mockResolvedValue(view());
    fireEvent.click(screen.getByRole('button', { name: /try again|retry/i }));
    expect(await screen.findByText('Your weekly fee: GY$45,000 a week')).toBeTruthy();
  });

  it('[REVIEW-F S3-1 · S4-1] a tick is needed but the answer cannot be read (a fractional amount, no words): could not be loaded, never a blank', async () => {
    for (const v of [view({ weeklyFee: { amount: 45000.5, currencyCode: 'GYD', tier: 'department', version: 'v1' } }), view({ terms: null })]) {
      vi.spyOn(feeApi, 'getStoreFee').mockResolvedValue(v);
      const { unmount } = renderWithQuery(<StoreFeeCard storeId="store-2" isOwner />);
      expect(await screen.findByText(/Couldn.t load your weekly fee/)).toBeTruthy();
      expect(screen.queryByRole('checkbox')).toBeNull();
      unmount();
    }
  });

  it('[REVIEW-F N2] once saved it says so', async () => {
    const read = vi.spyOn(feeApi, 'getStoreFee').mockResolvedValue(view());
    vi.spyOn(feeApi, 'tickStoreFee').mockImplementation(async () => { read.mockResolvedValue(view({ ticked: true })); return {} as never; });
    renderWithQuery(<StoreFeeCard storeId="store-2" isOwner />);
    fireEvent.click(await screen.findByRole('checkbox', { name: TERMS.tick }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    expect(await screen.findByText(/Saved\. Your store goes live once Swift.s other checks are done\./)).toBeTruthy();
  });

  it('[REVIEW-G S4 W6/W7] the read and the tick name the store in their own header; Settings passes the real owner flag', () => {
    const api = readFileSync(join(__dirname, '..', '..', '..', 'lib', 'store-fee-api.ts'), 'utf8');
    expect(api).toContain("apiFetch('/api/v1/vendor/onboarding/weekly-fee', { headers: { 'x-vendor-id': vendorId } })");
    expect(api).toContain("{ method: 'POST', headers: { 'x-vendor-id': tick.vendorId }, body: JSON.stringify(tick) }");
    expect(readFileSync(join(__dirname, 'page.tsx'), 'utf8')).toContain('<StoreFeeCard storeId={storeId} isOwner={isOwner} />');
  });

  it('the go-live step points the owner to Settings', () => {
    expect(GO_LIVE_STEPS['WEEKLY_FEE']).toEqual({ words: 'Read and tick its weekly fee', where: 'settings' });
  });
});
