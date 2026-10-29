import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithQuery } from '@/test/test-utils';
import * as vendorApi from '@/lib/vendor-api';
import { CallUsCard } from './call-us-card';

// ---------------------------------------------------------------------------
// [REVIEW-F #2220 S3-1] The number customers can call, on the website (the phone's call-us card, its words): the step
// a waiting store's owner may still owe before it goes live. Owner and managers (the API's own rule); trimmed; empty
// takes it down; a refusal in the server's own words. Synthetic stores only.
// ---------------------------------------------------------------------------

const profile = (myRole: string, publicPhone: string | null = null, steps: string[] = []) => ({
  id: 'owner-1', userId: 'user-1', myRole,
  vendors: [
    { id: 'store-1', name: 'Sample Kitchen', publicPhone, goLive: steps.length ? { waitingFor: 'OWNER', steps } : null },
    { id: 'store-2', name: 'Other', publicPhone: '+5922251234', goLive: null },
  ],
});

beforeEach(() => { vi.spyOn(vendorApi, 'updateProfile').mockResolvedValue({ success: true } as never); });
afterEach(() => { vi.restoreAllMocks(); });

describe('[CHAINS] the call-us number card', () => {
  it('the owner publishes the selected store\'s number (trimmed), told it is what the store needs to go live', async () => {
    vi.spyOn(vendorApi, 'getProfile').mockResolvedValue(profile('OWNER', null, ['PUBLISHED_PHONE']) as never);
    renderWithQuery(<CallUsCard storeId="store-1" />);
    const box = await screen.findByLabelText('Your call-us number');
    expect(screen.getByText('This store goes live only once it has a number customers can call.')).toBeTruthy();
    expect(screen.getByText(/separate from the number you sign in with, which stays private/)).toBeTruthy();
    await userEvent.type(box, '  +592 600 7788 ');
    await userEvent.click(screen.getByRole('button', { name: 'Save number' }));
    await waitFor(() => expect(vendorApi.updateProfile).toHaveBeenCalledWith({ publicPhone: '+592 600 7788' }));
  });

  it('a manager may set it too; emptying it takes it down (null)', async () => {
    vi.spyOn(vendorApi, 'getProfile').mockResolvedValue(profile('MANAGER', '+5926007788') as never);
    renderWithQuery(<CallUsCard storeId="store-1" />);
    const box = await screen.findByLabelText('Your call-us number');
    await waitFor(() => expect((box as HTMLInputElement).value).toBe('+5926007788'));
    expect(screen.queryByText(/goes live only once/)).toBeNull();
    await userEvent.clear(box);
    await userEvent.click(screen.getByRole('button', { name: 'Remove number' }));
    await waitFor(() => expect(vendorApi.updateProfile).toHaveBeenCalledWith({ publicPhone: null }));
  });

  it('shows the server\'s refusal in its own words', async () => {
    vi.spyOn(vendorApi, 'getProfile').mockResolvedValue(profile('OWNER') as never);
    vi.spyOn(vendorApi, 'updateProfile').mockRejectedValue(new Error('A Guyana number has 7 digits after +592, like +592 225 1234.'));
    renderWithQuery(<CallUsCard storeId="store-1" />);
    await userEvent.type(await screen.findByLabelText('Your call-us number'), '+592 1');
    await userEvent.click(screen.getByRole('button', { name: 'Save number' }));
    expect((await screen.findByRole('alert')).textContent).toBe('A Guyana number has 7 digits after +592, like +592 225 1234.');
  });

  it('is not offered to staff', async () => {
    vi.spyOn(vendorApi, 'getProfile').mockResolvedValue(profile('STAFF') as never);
    renderWithQuery(<CallUsCard storeId="store-1" />);
    await waitFor(() => expect(vendorApi.getProfile).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByLabelText('Your call-us number')).toBeNull();
  });
});
