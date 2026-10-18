import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithQuery } from '@/test/test-utils';
import * as vendorApi from '@/lib/vendor-api';
import { RefundRuleCard } from './refund-rule-card';

// ---------------------------------------------------------------------------
// [R3 · CAA s.70(3)] The store's own refund rule, set by its owner on the web
// dashboard: the words its storefront shows under "Refunds". Owner only (the
// API refuses anyone else); empty takes it down ("Ask the store"); a refusal
// is shown in the server's own words. Synthetic store only.
// ---------------------------------------------------------------------------

const profile = (myRole: string, refundRule: string | null = null) => ({
  id: 'owner-1', userId: 'user-1', myRole,
  vendors: [{ id: 'store-1', name: 'Sample Kitchen', refundRule }, { id: 'store-2', name: 'Other', refundRule: 'Other rule.' }],
});

beforeEach(() => {
  vi.spyOn(vendorApi, 'updateProfile').mockResolvedValue({ success: true } as never);
});
afterEach(() => { vi.restoreAllMocks(); });

describe('[R3] the refund rule card', () => {
  it('the owner writes the selected store’s rule and saves exactly those words (trimmed)', async () => {
    vi.spyOn(vendorApi, 'getProfile').mockResolvedValue(profile('OWNER') as never);
    renderWithQuery(<RefundRuleCard storeId="store-1" />);
    const box = await screen.findByLabelText('Your refund rule');
    expect((box as HTMLTextAreaElement).value).toBe('');
    await userEvent.type(box, '  Exchanges within 7 days.  ');
    await userEvent.click(screen.getByRole('button', { name: 'Save refund rule' }));
    await waitFor(() => expect(vendorApi.updateProfile).toHaveBeenCalledWith({ refundRule: 'Exchanges within 7 days.' }));
  });

  it('shows the rule on file for the selected store; emptying it saves null (the page then says "Ask the store")', async () => {
    vi.spyOn(vendorApi, 'getProfile').mockResolvedValue(profile('OWNER', 'Refunds within 3 days.') as never);
    renderWithQuery(<RefundRuleCard storeId="store-1" />);
    const box = await screen.findByLabelText('Your refund rule');
    await waitFor(() => expect((box as HTMLTextAreaElement).value).toBe('Refunds within 3 days.'));
    await userEvent.clear(box);
    await userEvent.click(screen.getByRole('button', { name: 'Remove refund rule' }));
    await waitFor(() => expect(vendorApi.updateProfile).toHaveBeenCalledWith({ refundRule: null }));
  });

  it('shows the server’s refusal in its own words', async () => {
    vi.spyOn(vendorApi, 'getProfile').mockResolvedValue(profile('OWNER') as never);
    vi.spyOn(vendorApi, 'updateProfile').mockRejectedValue(new Error('Write your refund rule in plain words, without links or web addresses.'));
    renderWithQuery(<RefundRuleCard storeId="store-1" />);
    await userEvent.type(await screen.findByLabelText('Your refund rule'), 'See www.example.com');
    await userEvent.click(screen.getByRole('button', { name: 'Save refund rule' }));
    expect((await screen.findByRole('alert')).textContent).toBe('Write your refund rule in plain words, without links or web addresses.');
  });

  it('is not offered to a manager or staff member', async () => {
    vi.spyOn(vendorApi, 'getProfile').mockResolvedValue(profile('MANAGER') as never);
    renderWithQuery(<RefundRuleCard storeId="store-1" />);
    await waitFor(() => expect(vendorApi.getProfile).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByLabelText('Your refund rule')).toBeNull();
  });
});
