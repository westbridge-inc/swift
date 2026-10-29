import { screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mockApi, renderWithQuery, type ApiRequest } from '@/test/test-utils';
import BranchMenuCopy from './branch-menu-copy';
import type { Store } from '@/lib/vendor-api';

// [CHAINS PR2] Copy the menu from another branch into this empty one: the same copy key on a retry (a dropped answer
// never makes a second copy), a new key for a new copy; the result in words.
const stores = [
  { id: 'camp', name: 'Royal Camp', vendorType: 'RESTAURANT', isCurrentlyOpen: true, acceptingOrders: true, city: null, isVerified: true, status: 'ACTIVE', awaitingApproval: false },
  { id: 'north', name: 'Royal North', vendorType: 'RESTAURANT', isCurrentlyOpen: true, acceptingOrders: true, city: null, isVerified: true, status: 'ACTIVE', awaitingApproval: false },
  { id: 'east', name: 'Royal East', vendorType: 'RESTAURANT', isCurrentlyOpen: false, acceptingOrders: false, city: null, isVerified: false, status: 'PENDING_APPROVAL', awaitingApproval: true },
] as Store[];

const copies: Array<{ store: string | undefined; body: { fromStoreId: string; copyKey: string } }> = [];
function api(failFirst: boolean) {
  let failed = !failFirst;
  return mockApi(({ url, init }: ApiRequest) => {
    if (url.pathname !== '/api/v1/vendor/menu/copy') return { status: 404, body: { success: false } };
    copies.push({ store: (init?.headers as Record<string, string> | undefined)?.['x-vendor-id'], body: JSON.parse(String(init?.body)) });
    if (!failed) { failed = true; return { status: 503, body: { success: false, error: { message: 'Swift is busy right now. Try again.' } } }; }
    return { body: { success: true, data: { fromStoreId: 'north', categories: 2, items: 4, options: 2, photos: 2, photosNotCopied: 0, waitingForCheck: 0, notAllowed: [{ name: 'Hennessy VS' }], replayed: false } } };
  });
}

beforeEach(async () => {
  copies.length = 0;
  (await import('@/lib/auth')).setSelectedStore('camp');
});

describe('[CHAINS] copy the menu from another branch (web)', () => {
  it('a retry after a failed answer sends the SAME copy key; the copy goes into the selected branch', async () => {
    api(true);
    const onCopied = vi.fn();
    const { user } = renderWithQuery(<BranchMenuCopy storeId="camp" stores={stores} onCopied={onCopied} />);
    expect(screen.queryByRole('option', { name: 'Royal East' }), 'a branch waiting for approval is not a source').toBeNull();
    await user.selectOptions(screen.getByLabelText('Copy from'), 'north');
    await user.click(screen.getByRole('button', { name: 'Copy Royal North’s menu here' }));
    expect(await screen.findByText('Swift is busy right now. Try again.')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Copy Royal North’s menu here' }));
    expect(await screen.findByText('Copied 4 items in 2 sections, with 2 photos.')).toBeTruthy();
    expect(screen.getByText('Not copied, Swift doesn’t allow: Hennessy VS.')).toBeTruthy();
    expect(copies).toHaveLength(2);
    expect(copies[0]!.body.fromStoreId).toBe('north');
    expect(copies[1]!.body.copyKey).toBe(copies[0]!.body.copyKey);
    expect(copies.every((c) => c.store === 'camp')).toBe(true);
    expect(onCopied).toHaveBeenCalledTimes(1);
  });

  it('choosing another branch starts a new copy (a new key)', async () => {
    api(true);
    const { user } = renderWithQuery(<BranchMenuCopy storeId="camp" stores={stores} onCopied={() => {}} />);
    await user.selectOptions(screen.getByLabelText('Copy from'), 'north');
    await user.click(screen.getByRole('button', { name: 'Copy Royal North’s menu here' }));
    await screen.findByText('Swift is busy right now. Try again.');
    await user.selectOptions(screen.getByLabelText('Copy from'), 'north');
    const first = copies[0]!.body.copyKey;
    // Re-choosing the source clears the kept key.
    await user.click(screen.getByRole('button', { name: 'Copy Royal North’s menu here' }));
    await screen.findByText('Copied 4 items in 2 sections, with 2 photos.');
    expect(copies[1]!.body.copyKey).not.toBe(first);
  });
});
