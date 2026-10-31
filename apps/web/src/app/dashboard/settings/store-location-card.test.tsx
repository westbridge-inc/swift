import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockApi, renderWithQuery, type ApiRequest } from '@/test/test-utils';
import { setSelectedStore } from '@/lib/auth';
import { STORE_LOCATION_WORDS, StoreLocationCard } from './store-location-card';

// ---------------------------------------------------------------------------
// [WEB-SETTINGS · owner 31 Oct 2026] Where the store is, on the website: the phone's Account > "Store location" (owner
// only, the API's rule too). The pin is moved with the website's own store-location picker (loaded only when opened)
// and saved as PUT /vendor/profile { latitude, longitude }, nothing else, as the phone sends it; the server holds a
// moved pin to the market rule and its refusal is shown in its words. The address words (street, city, region) are
// the owner's too, saved on their own. Synthetic places only.
// ---------------------------------------------------------------------------

const loads = vi.hoisted(() => ({ count: 0 }));
vi.mock('@/app/signup/store-picker-loader', () => ({
  loadStorePicker: async () => {
    loads.count += 1;
    return {
      StoreLocationPicker: ({ current, onConfirm, onClose }: { current: { latitude: number; longitude: number } | null; onConfirm: (_p: { latitude: number; longitude: number; address: string | null }) => void; onClose: () => void }) => (
        <div>
          <p>Picker opened at {current ? `${current.latitude},${current.longitude}` : 'nowhere'}</p>
          <button type="button" onClick={() => onConfirm({ latitude: 6.81, longitude: -58.16, address: 'Sample Street' })}>Confirm store location</button>
          <button type="button" onClick={onClose}>Close without placing the pin</button>
        </div>
      ),
    };
  },
}));

type Opts = { role?: string; refuse?: string };
const calls: Array<{ method: string; path: string; body: unknown }> = [];
function api(opts: Opts = {}) {
  let store = { addressLine1: '1 Sample Street', city: 'Town A', region: null as string | null, latitude: 6.8, longitude: -58.15 };
  return mockApi(({ method, url, init }: ApiRequest) => {
    const path = url.pathname.replace('/api/v1', '');
    const body = init?.body && typeof init.body === 'string' ? JSON.parse(init.body) : null;
    calls.push({ method, path, body });
    if (path === '/vendor/profile' && method === 'GET') {
      return { body: { success: true, data: { id: 'owner-1', userId: 'user-1', myRole: opts.role ?? 'OWNER', vendors: [{ id: 'store-1', name: 'Sample Kitchen', vendorType: 'RESTAURANT', ...store }] } } };
    }
    if (path === '/vendor/profile' && method === 'PUT') {
      if (opts.refuse) return { status: 400, body: { success: false, error: { code: 'STORE_PIN_OUTSIDE_MARKET', message: opts.refuse } } };
      store = { ...store, ...body };
      return { body: { success: true, data: {} } };
    }
    return { body: { success: true, data: {} } };
  });
}
const puts = () => calls.filter((c) => c.method === 'PUT');

beforeEach(() => { calls.length = 0; loads.count = 0; setSelectedStore('store-1'); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); localStorage.clear(); });

describe('[WEB-SETTINGS] the store\'s location (web)', () => {
  it('the owner moves the pin: the picker loads only when opened, starts at the current pin, and only { latitude, longitude } is sent', async () => {
    api();
    const { user } = renderWithQuery(<StoreLocationCard storeId="store-1" />);
    expect(await screen.findByRole('heading', { name: 'Store location' })).toBeTruthy();
    expect(screen.getByText('1 Sample Street, Town A')).toBeTruthy();
    expect(loads.count).toBe(0);
    await user.click(screen.getByRole('button', { name: 'Move the pin' }));
    expect(await screen.findByText('Picker opened at 6.8,-58.15')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Confirm store location' }));
    await waitFor(() => expect(puts()).toHaveLength(1));
    expect(puts()[0]!.body).toEqual({ latitude: 6.81, longitude: -58.16 });
    expect(await screen.findByText(STORE_LOCATION_WORDS.moved)).toBeTruthy();
    expect(screen.queryByText(/Picker opened/)).toBeNull();
  });

  it('closing the picker saves nothing', async () => {
    api();
    const { user } = renderWithQuery(<StoreLocationCard storeId="store-1" />);
    await user.click(await screen.findByRole('button', { name: 'Move the pin' }));
    await user.click(await screen.findByRole('button', { name: 'Close without placing the pin' }));
    expect(screen.queryByText(/Picker opened/)).toBeNull();
    expect(puts()).toHaveLength(0);
  });

  it('a pin the server refuses keeps the picker open with the server\'s words', async () => {
    api({ refuse: 'That pin is outside the area Swift serves. Move it to your store\'s entrance.' });
    const { user } = renderWithQuery(<StoreLocationCard storeId="store-1" />);
    await user.click(await screen.findByRole('button', { name: 'Move the pin' }));
    await user.click(await screen.findByRole('button', { name: 'Confirm store location' }));
    expect((await screen.findByRole('alert')).textContent).toBe('That pin is outside the area Swift serves. Move it to your store\'s entrance.');
    expect(screen.getByText(/Picker opened/)).toBeTruthy();
  });

  it('the owner corrects the address words; only what changed is sent, trimmed, and the pin is not touched', async () => {
    api();
    const { user } = renderWithQuery(<StoreLocationCard storeId="store-1" />);
    await user.click(await screen.findByRole('button', { name: 'Edit the address' }));
    const line = screen.getByLabelText('Street address') as HTMLInputElement;
    expect(line.value).toBe('1 Sample Street');
    await user.clear(line);
    await user.type(line, ' 2 Sample Street ');
    await user.type(screen.getByLabelText('Region (optional)'), 'Region Four');
    expect(screen.getByText(STORE_LOCATION_WORDS.pinStays)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Save address' }));
    await waitFor(() => expect(puts()).toHaveLength(1));
    expect(puts()[0]!.body).toEqual({ addressLine1: '2 Sample Street', region: 'Region Four' });
    expect(await screen.findByText('2 Sample Street, Town A, Region Four')).toBeTruthy();
  });

  it('an address too short is refused before anything is sent (sign-up\'s own minimums)', async () => {
    api();
    const { user } = renderWithQuery(<StoreLocationCard storeId="store-1" />);
    await user.click(await screen.findByRole('button', { name: 'Edit the address' }));
    await user.clear(screen.getByLabelText('City or village'));
    await user.type(screen.getByLabelText('City or village'), 'X');
    await user.click(screen.getByRole('button', { name: 'Save address' }));
    expect((await screen.findByRole('alert')).textContent).toBe(STORE_LOCATION_WORDS.addressTooShort);
    expect(puts()).toHaveLength(0);
  });

  it('managers and staff do not get the card (owner only, as the phone and the API)', async () => {
    for (const role of ['MANAGER', 'STAFF']) {
      calls.length = 0;
      api({ role });
      const { unmount } = renderWithQuery(<StoreLocationCard storeId="store-1" />);
      await waitFor(() => expect(calls.some((c) => c.path === '/vendor/profile')).toBe(true));
      await new Promise((r) => setTimeout(r, 0));
      expect(screen.queryByRole('heading', { name: 'Store location' })).toBeNull();
      unmount();
      vi.unstubAllGlobals();
    }
  });

  it('the pin words are the phone\'s (VendorAccountScreen StoreLocationCard)', () => {
    const phone = readFileSync(join(process.cwd(), '..', 'mobile', 'src', 'modules', 'vendor', 'screens', 'VendorAccountScreen.tsx'), 'utf8');
    expect(phone).toContain("toast.success('Store pin moved', 'Riders and customers will come to the new spot.')");
    expect(STORE_LOCATION_WORDS.moved).toBe('Store pin moved. Riders and customers will come to the new spot.');
    expect(phone).toContain(`'${STORE_LOCATION_WORDS.pinFailed}'`);
    expect(phone).toContain(`label="${STORE_LOCATION_WORDS.title}"`);
  });
});
