import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mockApi, renderWithQuery, type ApiRequest } from '@/test/test-utils';
import CategoriesPage, { CATEGORY_WORDS } from './page';

// ---------------------------------------------------------------------------
// [WEB-SETTINGS PR-B · owner 31 Oct 2026] "Review your categories" on the website, as the phone's
// VendorCategoryReviewScreen: GET /vendor/category-suggestions, POST /vendor/category-suggestions/:id/accept|dismiss.
// Managers and owners (the server's rule). Synthetic items only.
// ---------------------------------------------------------------------------

const writes: Array<{ method: string; path: string; body: unknown }> = [];
function api(opts: { role?: string; groups?: unknown[]; fail?: boolean; refuse?: string } = {}) {
  let groups = (opts.groups ?? [
    { itemId: 'i1', itemName: 'Sample Rice 5 kg', imageUrl: null, suggestions: [
      { id: 's1', slug: 'rice', name: 'Rice & grains', confidence: 0.9, stage: 'PENDING' },
      { id: 's2', slug: 'pantry', name: 'Pantry', confidence: 0.5, stage: 'PENDING' },
    ] },
    { itemId: 'i2', itemName: 'Sample Juice', imageUrl: null, suggestions: [{ id: 's3', slug: 'drinks', name: 'Drinks', confidence: 0.8, stage: 'PENDING' }] },
  ]) as Array<{ itemId: string; suggestions: Array<{ id: string }> }>;
  return mockApi(({ method, url, init }: ApiRequest) => {
    const path = url.pathname.replace('/api/v1', '');
    const body = init?.body && typeof init.body === 'string' ? JSON.parse(init.body) : null;
    if (method !== 'GET') writes.push({ method, path, body });
    if (path === '/vendor/stores') return { body: { success: true, data: { stores: [{ id: 'store-1', name: 'Sample Shop' }], selectedId: 'store-1', myRole: opts.role ?? 'OWNER' } } };
    if (path === '/vendor/category-suggestions') {
      if (opts.fail) return { status: 500, body: { success: false, error: { code: 'INTERNAL', message: 'Something went wrong' } } };
      return { body: { success: true, data: groups } };
    }
    if (path.startsWith('/vendor/category-suggestions/') && method === 'POST') {
      if (opts.refuse) return { status: 404, body: { success: false, error: { code: 'NOT_FOUND', message: opts.refuse } } };
      const id = path.split('/')[3];
      groups = groups.map((g) => ({ ...g, suggestions: g.suggestions.filter((s) => s.id !== id) })).filter((g) => g.suggestions.length > 0);
      return { body: { success: true, data: { status: path.endsWith('/accept') ? 'ACCEPTED' : 'DISMISSED' } } };
    }
    return { body: { success: true, data: {} } };
  });
}

beforeEach(async () => {
  writes.length = 0;
  (await import('@/lib/auth')).setSelectedStore('store-1');
});

describe('[WEB-SETTINGS PR-B] review your categories (web)', () => {
  it('counts the suggestions honestly and groups them by item', async () => {
    api();
    renderWithQuery(<CategoriesPage />);
    expect(await screen.findByText('3 suggestions across 2 items. Customers browse the Market by category, so a listing with none is harder to find.')).toBeTruthy();
    const rice = screen.getByText('Sample Rice 5 kg').closest('li')!;
    expect(within(rice).getByText('Rice & grains')).toBeTruthy();
    expect(within(rice).getByText('Pantry')).toBeTruthy();
    expect(screen.getByText(CATEGORY_WORDS.final)).toBeTruthy();
  });

  it('Yes accepts exactly that suggestion, says where it went, and the list re-reads', async () => {
    api();
    const { user } = renderWithQuery(<CategoriesPage />);
    await user.click(await screen.findByRole('button', { name: 'Yes, Sample Rice 5 kg is Rice & grains' }));
    await waitFor(() => expect(writes).toEqual([{ method: 'POST', path: '/vendor/category-suggestions/s1/accept', body: {} }]));
    expect((await screen.findByRole('status')).textContent).toBe('Added to Rice & grains');
    await waitFor(() => expect(screen.queryByText('Rice & grains')).toBeNull());
    expect(screen.getByText(/^2 suggestions across 2 items/)).toBeTruthy();
  });

  it('Not this dismisses exactly that suggestion', async () => {
    api();
    const { user } = renderWithQuery(<CategoriesPage />);
    await user.click(await screen.findByRole('button', { name: 'Not Drinks — dismiss this suggestion for Sample Juice' }));
    await waitFor(() => expect(writes).toEqual([{ method: 'POST', path: '/vendor/category-suggestions/s3/dismiss', body: {} }]));
    expect((await screen.findByRole('status')).textContent).toBe('Suggestion dismissed');
  });

  it('a refusal is shown in the server\'s words, never as done', async () => {
    api({ refuse: 'Suggestion not found' });
    const { user } = renderWithQuery(<CategoriesPage />);
    await user.click(await screen.findByRole('button', { name: 'Yes, Sample Juice is Drinks' }));
    expect((await screen.findByRole('alert')).textContent).toBe('Suggestion not found');
    expect(screen.queryByText('Added to Drinks')).toBeNull();
  });

  it('nothing to review says so; a failed read is never "nothing to review"', async () => {
    api({ groups: [] });
    const first = renderWithQuery(<CategoriesPage />);
    expect(await screen.findByText(CATEGORY_WORDS.emptyTitle)).toBeTruthy();
    expect(screen.getByText(CATEGORY_WORDS.browse)).toBeTruthy();
    first.unmount();
    vi.unstubAllGlobals();
    api({ fail: true });
    renderWithQuery(<CategoriesPage />);
    expect(await screen.findByRole('button', { name: /Try again|Retry/ })).toBeTruthy();
    expect(screen.queryByText(CATEGORY_WORDS.emptyTitle)).toBeNull();
  });

  it('staff are told who reviews them, and nothing is read', async () => {
    const fetchMock = api({ role: 'STAFF' });
    renderWithQuery(<CategoriesPage />);
    expect(await screen.findByText(CATEGORY_WORDS.staff)).toBeTruthy();
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes('/vendor/category-suggestions'))).toBe(false);
  });

  it('every sentence is the phone\'s own (VendorCategoryReviewScreen)', () => {
    const phone = readFileSync(join(process.cwd(), '..', 'mobile', 'src', 'modules', 'vendor', 'screens', 'VendorCategoryReviewScreen.tsx'), 'utf8');
    for (const words of [CATEGORY_WORDS.browse, CATEGORY_WORDS.emptyTitle, CATEGORY_WORDS.emptyBody, CATEGORY_WORDS.final, CATEGORY_WORDS.failed,
      'Review your categories', 'Customers browse the Market by category, so a listing with none is harder to find.', 'Not this', 'Suggestion dismissed', 'Added to ']) {
      expect(phone, words).toContain(words);
    }
  });
});
