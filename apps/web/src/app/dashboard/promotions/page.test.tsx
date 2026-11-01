import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mockApi, renderWithQuery, type ApiRequest } from '@/test/test-utils';
import PromotionsPage, { PROMO_WORDS } from './page';

// ---------------------------------------------------------------------------
// [WEB-SETTINGS PR-B · owner 31 Oct 2026] A store's own promo codes on the website, as the phone's Account >
// Promotions (PromosSection): the same GET/POST/PUT/DELETE /vendor/promos, the same form (code in capitals, what
// customers see, % or GYD off, an optional minimum, 3/7/14/30 days), the same Pause/Resume and the same asked-first
// delete. Managers and owners (the server's rule). Synthetic codes only.
// ---------------------------------------------------------------------------

const NOW = Date.now();
const writes: Array<{ method: string; path: string; body: unknown }> = [];
function api(opts: { role?: string; promos?: unknown[]; fail?: boolean; refuse?: string } = {}) {
  let promos = opts.promos ?? [
    { id: 'p1', code: 'SAVE20', description: '20% off', discountType: 'PERCENTAGE', discountValue: '20', minOrderAmount: '2000', validUntil: new Date(NOW + 86_400_000).toISOString(), isActive: true, currentUses: 3 },
    { id: 'p2', code: 'OLD500', description: 'old', discountType: 'FIXED_AMOUNT', discountValue: '500', minOrderAmount: null, validUntil: new Date(NOW - 86_400_000).toISOString(), isActive: true, currentUses: 0 },
  ];
  return mockApi(({ method, url, init }: ApiRequest) => {
    const path = url.pathname.replace('/api/v1', '');
    const body = init?.body && typeof init.body === 'string' ? JSON.parse(init.body) : null;
    if (method !== 'GET') writes.push({ method, path, body });
    if (path === '/vendor/stores') return { body: { success: true, data: { stores: [{ id: 'store-1', name: 'Sample Kitchen' }], selectedId: 'store-1', myRole: opts.role ?? 'OWNER' } } };
    if (path === '/vendor/promos' && method === 'GET') {
      if (opts.fail) return { status: 500, body: { success: false, error: { code: 'INTERNAL', message: 'Something went wrong' } } };
      return { body: { success: true, data: promos } };
    }
    if (path === '/vendor/promos' && method === 'POST') {
      if (opts.refuse) return { status: 409, body: { success: false, error: { code: 'CODE_TAKEN', message: opts.refuse } } };
      promos = [{ id: 'p3', ...body, isActive: true, currentUses: 0 }, ...promos];
      return { body: { success: true, data: promos[0] } };
    }
    if (path.startsWith('/vendor/promos/') && method === 'DELETE') { promos = promos.filter((p) => (p as { id: string }).id !== path.split('/').pop()); return { body: { success: true, data: { deleted: true } } }; }
    if (path.startsWith('/vendor/promos/') && method === 'PUT') return { body: { success: true, data: {} } };
    return { body: { success: true, data: {} } };
  });
}

beforeEach(async () => {
  writes.length = 0;
  (await import('@/lib/auth')).setSelectedStore('store-1');
});

describe('[WEB-SETTINGS PR-B] promotions (web)', () => {
  it('lists each code with its state and terms in the phone\'s words; an expired code cannot be paused', async () => {
    api();
    renderWithQuery(<PromotionsPage />);
    const live = (await screen.findByText('SAVE20')).closest('li')!;
    expect(within(live).getByText('Live')).toBeTruthy();
    expect(live.textContent).toMatch(/20% off over .*2,000 · used 3×/);
    expect(within(live).getByRole('button', { name: 'Pause' })).toBeTruthy();
    const old = screen.getByText('OLD500').closest('li')!;
    expect(within(old).getByText('Expired')).toBeTruthy();
    expect(within(old).queryByRole('button', { name: /Pause|Resume/ })).toBeNull();
  });

  it('a new code: the button names what is missing, then sends exactly the phone\'s body', async () => {
    api();
    const { user } = renderWithQuery(<PromotionsPage />);
    await user.click(await screen.findByRole('button', { name: 'New promotion' }));
    expect(screen.getByRole('button', { name: 'Enter a code' })).toBeTruthy();
    await user.type(screen.getByLabelText('Code'), 'save10');
    expect(screen.getByRole('button', { name: 'Describe it for customers' })).toBeTruthy();
    await user.type(screen.getByLabelText('What customers see'), ' 10% off this week ');
    expect(screen.getByRole('button', { name: 'Set the discount' })).toBeTruthy();
    await user.click(screen.getByRole('radio', { name: 'GYD off' }));
    await user.type(screen.getByLabelText('Discount (GYD)'), '500');
    await user.type(screen.getByLabelText('Minimum order (optional)'), '3000');
    await user.click(screen.getByRole('radio', { name: '14 days' }));
    const before = Date.now();
    await user.click(screen.getByRole('button', { name: 'Launch promotion' }));
    await waitFor(() => expect(writes.filter((w) => w.method === 'POST')).toHaveLength(1));
    const sent = writes[0]!.body as Record<string, unknown>;
    expect({ ...sent, validUntil: undefined }).toEqual({ code: 'SAVE10', description: '10% off this week', discountType: 'FIXED_AMOUNT', discountValue: 500, minOrderAmount: 3000, validUntil: undefined });
    const until = new Date(String(sent['validUntil'])).getTime();
    expect(until - before).toBeGreaterThanOrEqual(14 * 86_400_000 - 1000);
    expect(until - before).toBeLessThanOrEqual(14 * 86_400_000 + 60_000);
    expect(await screen.findByText('SAVE10')).toBeTruthy();
  });

  it('no minimum is not sent; the server\'s refusal is shown in its words', async () => {
    api({ refuse: 'That code is already in use — pick another' });
    const { user } = renderWithQuery(<PromotionsPage />);
    await user.click(await screen.findByRole('button', { name: 'New promotion' }));
    await user.type(screen.getByLabelText('Code'), 'SAVE20');
    await user.type(screen.getByLabelText('What customers see'), '20% off');
    await user.type(screen.getByLabelText('Discount (%)'), '20');
    await user.click(screen.getByRole('button', { name: 'Launch promotion' }));
    expect((await screen.findByRole('alert')).textContent).toBe('That code is already in use — pick another');
    expect(writes[0]!.body).not.toHaveProperty('minOrderAmount');
  });

  it('Pause sends { isActive: false } for that code', async () => {
    api();
    const { user } = renderWithQuery(<PromotionsPage />);
    const live = (await screen.findByText('SAVE20')).closest('li')!;
    await user.click(within(live).getByRole('button', { name: 'Pause' }));
    await waitFor(() => expect(writes).toEqual([{ method: 'PUT', path: '/vendor/promos/p1', body: { isActive: false } }]));
  });

  it('delete asks first, says what happens, and "Keep it" sends nothing', async () => {
    api();
    const { user } = renderWithQuery(<PromotionsPage />);
    const live = (await screen.findByText('SAVE20')).closest('li')!;
    await user.click(within(live).getByRole('button', { name: 'Delete promo SAVE20' }));
    expect(screen.getByText('Delete “SAVE20”?')).toBeTruthy();
    expect(screen.getByText('Customers used it 3× — it disappears from your storefront immediately.')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Keep it' }));
    expect(writes).toHaveLength(0);
    await user.click(within(live).getByRole('button', { name: 'Delete promo SAVE20' }));
    await user.click(screen.getByRole('button', { name: 'Delete promo' }));
    await waitFor(() => expect(writes).toEqual([{ method: 'DELETE', path: '/vendor/promos/p1', body: null }]));
  });

  it('none yet says so; a failed read is never "none yet"', async () => {
    api({ promos: [] });
    const first = renderWithQuery(<PromotionsPage />);
    expect(await screen.findByText(PROMO_WORDS.none)).toBeTruthy();
    first.unmount();
    vi.unstubAllGlobals();
    api({ fail: true });
    renderWithQuery(<PromotionsPage />);
    expect(await screen.findByRole('button', { name: /Try again|Retry/ })).toBeTruthy();
    expect(screen.queryByText(PROMO_WORDS.none)).toBeNull();
  });

  it('staff are told the manager and owner run promotions, and nothing is read', async () => {
    const fetchMock = api({ role: 'STAFF' });
    renderWithQuery(<PromotionsPage />);
    expect(await screen.findByText(PROMO_WORDS.staff)).toBeTruthy();
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes('/vendor/promos'))).toBe(false);
  });

  it('every sentence is the phone\'s own (VendorAccountScreen PromosSection)', () => {
    const phone = readFileSync(join(process.cwd(), '..', 'mobile', 'src', 'modules', 'vendor', 'screens', 'VendorAccountScreen.tsx'), 'utf8');
    for (const words of [PROMO_WORDS.none, 'Enter a code', 'Describe it for customers', 'Set the discount', 'Launch promotion', 'New promotion',
      'it disappears from your storefront immediately.', 'Delete promo', 'Keep it', '% off', 'GYD off']) {
      expect(phone, words).toContain(words);
    }
  });
});
