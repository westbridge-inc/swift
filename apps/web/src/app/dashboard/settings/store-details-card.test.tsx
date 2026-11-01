import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockApi, renderWithQuery, type ApiRequest } from '@/test/test-utils';
import { setSelectedStore } from '@/lib/auth';
import { site } from '@/site.config';
import { checkedNameWords, OWN_NAME_RENAME_WORDS, StoreDetailsCard, STORE_DETAILS_OWNER_ONLY } from './store-details-card';

// ---------------------------------------------------------------------------
// [WEB-SETTINGS · owner 31 Oct 2026] The store's name and description on the website. Partners have no app yet, and
// the page used to say these were "edited in the Swift app" (the phone has no such editor). The owner edits them with
// PUT /vendor/profile, sending only what changed; the server judges the words (a store trading under the owner's own
// name keeps it, and words that mention goods Swift doesn't carry wait for a person), and its answer is shown in its
// own words. A manager reads them only. Synthetic stores only.
// ---------------------------------------------------------------------------

type Opts = { role?: string; ownName?: boolean; checked?: boolean; waiting?: boolean; refuse?: { code: string; message: string } };
const calls: Array<{ method: string; path: string; body: unknown }> = [];
const WAITING = 'Your store is waiting for a quick check by Swift: its name, description or tags mention goods Swift doesn\'t carry. Customers can\'t see your store until Swift checks it. If you rename it, the check starts again.';

function api(opts: Opts = {}) {
  let name = 'Sample Kitchen';
  let description: string | null = 'Synthetic test kitchen.';
  let waiting = !!opts.waiting;
  return mockApi(({ method, url, init }: ApiRequest) => {
    const path = url.pathname.replace('/api/v1', '');
    const body = init?.body && typeof init.body === 'string' ? JSON.parse(init.body) : null;
    calls.push({ method, path, body });
    if (path === '/vendor/profile' && method === 'GET') {
      return { body: { success: true, data: { id: 'owner-1', userId: 'user-1', myRole: opts.role ?? 'OWNER', vendors: [
        { id: 'store-1', name, description, vendorType: 'RESTAURANT', city: 'Town A', isVerified: !!opts.checked, activationValidUntil: null, tradesUnderOwnName: !!opts.ownName,
          storeCheck: waiting ? { status: 'WAITING_FOR_CHECK', message: WAITING, prohibitedClass: 'X', field: 'name', term: 'x' } : null },
      ] } } };
    }
    if (path === '/vendor/profile' && method === 'PUT') {
      if (opts.refuse) return { status: 409, body: { success: false, error: opts.refuse } };
      if (typeof body.name === 'string') name = body.name;
      if (typeof body.description === 'string') description = body.description;
      if (body.name === 'Sample Smoke Shop') waiting = true;
      return { body: { success: true, data: { storeCheck: waiting ? { status: 'WAITING_FOR_CHECK', message: WAITING } : null } } };
    }
    return { body: { success: true, data: {} } };
  });
}
const puts = () => calls.filter((c) => c.method === 'PUT');

beforeEach(() => { calls.length = 0; setSelectedStore('store-1'); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); localStorage.clear(); });

describe('[WEB-SETTINGS] the store\'s name and description (web)', () => {
  it('shows the store as before, and never says the details are edited in the Swift app', async () => {
    api();
    renderWithQuery(<StoreDetailsCard storeId="store-1" />);
    expect(await screen.findByRole('heading', { name: 'Sample Kitchen' })).toBeTruthy();
    expect(screen.getByText(/Restaurant · Town A · Not checked by Swift yet: see Documents/)).toBeTruthy();
    expect(screen.getByText('Synthetic test kitchen.')).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/in the Swift app/);
  });

  it('the owner edits the name and description; only what changed is sent, trimmed', async () => {
    api();
    const { user } = renderWithQuery(<StoreDetailsCard storeId="store-1" />);
    await user.click(await screen.findByRole('button', { name: 'Edit name and description' }));
    const name = screen.getByLabelText('Store name') as HTMLInputElement;
    expect(name.value).toBe('Sample Kitchen');
    await user.clear(name);
    await user.type(name, '  Sample Grill  ');
    await user.click(screen.getByRole('button', { name: 'Save details' }));
    await waitFor(() => expect(puts()).toHaveLength(1));
    expect(puts()[0]!.body).toEqual({ name: 'Sample Grill' });
    expect(await screen.findByRole('heading', { name: 'Sample Grill' })).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Edit name and description' }));
    const about = screen.getByLabelText('Description') as HTMLTextAreaElement;
    await user.clear(about);
    await user.type(about, 'Curry and roti.');
    await user.click(screen.getByRole('button', { name: 'Save details' }));
    await waitFor(() => expect(puts()).toHaveLength(2));
    expect(puts()[1]!.body).toEqual({ description: 'Curry and roti.' });
  });

  it('nothing changed: nothing to save; a name too short is refused before anything is sent', async () => {
    api();
    const { user } = renderWithQuery(<StoreDetailsCard storeId="store-1" />);
    await user.click(await screen.findByRole('button', { name: 'Edit name and description' }));
    expect((screen.getByRole('button', { name: 'Save details' }) as HTMLButtonElement).disabled).toBe(true);
    await user.clear(screen.getByLabelText('Store name'));
    await user.type(screen.getByLabelText('Store name'), 'A');
    await user.click(screen.getByRole('button', { name: 'Save details' }));
    expect((await screen.findByRole('alert')).textContent).toBe('Enter the store’s name: 2 to 100 characters.');
    expect(puts()).toHaveLength(0);
  });

  it('a rename that mentions goods Swift doesn\'t carry: the server\'s "waiting for a quick check" words are shown', async () => {
    api();
    const { user } = renderWithQuery(<StoreDetailsCard storeId="store-1" />);
    await user.click(await screen.findByRole('button', { name: 'Edit name and description' }));
    await user.clear(screen.getByLabelText('Store name'));
    await user.type(screen.getByLabelText('Store name'), 'Sample Smoke Shop');
    await user.click(screen.getByRole('button', { name: 'Save details' }));
    expect(await screen.findByText(WAITING)).toBeTruthy();
  });

  it('a store already waiting for that check says so on the card', async () => {
    api({ waiting: true });
    renderWithQuery(<StoreDetailsCard storeId="store-1" />);
    expect(await screen.findByText(WAITING)).toBeTruthy();
  });

  it('a store trading under the owner\'s own name keeps it: the name box is locked with the server\'s reason', async () => {
    api({ ownName: true });
    const { user } = renderWithQuery(<StoreDetailsCard storeId="store-1" />);
    await user.click(await screen.findByRole('button', { name: 'Edit name and description' }));
    expect((screen.getByLabelText('Store name') as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByText(OWN_NAME_RENAME_WORDS)).toBeTruthy();
    const routes = readFileSync(join(process.cwd(), '..', 'api', 'src', 'modules', 'vendor', 'vendor.routes.ts'), 'utf8');
    expect(routes).toContain(`'OWN_NAME_RENAME', '${OWN_NAME_RENAME_WORDS}'`);
  });

  it('a store a person already checked keeps its name (a new one would not be checked again); its description still changes', async () => {
    api({ checked: true });
    const { user } = renderWithQuery(<StoreDetailsCard storeId="store-1" />);
    await user.click(await screen.findByRole('button', { name: 'Edit name and description' }));
    expect((screen.getByLabelText('Store name') as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByText(checkedNameWords(site.supportEmail))).toBeTruthy();
    await user.type(screen.getByLabelText('Description'), ' Open late.');
    await user.click(screen.getByRole('button', { name: 'Save details' }));
    await waitFor(() => expect(puts()).toHaveLength(1));
    expect(puts()[0]!.body).toEqual({ description: 'Synthetic test kitchen. Open late.' });
  });

  it('the server\'s refusal is shown in its own words', async () => {
    api({ refuse: { code: 'RESERVED_NAME', message: 'Names starting with "TEST-" are reserved for Swift’s test accounts. Please choose another name.' } });
    const { user } = renderWithQuery(<StoreDetailsCard storeId="store-1" />);
    await user.click(await screen.findByRole('button', { name: 'Edit name and description' }));
    await user.clear(screen.getByLabelText('Store name'));
    await user.type(screen.getByLabelText('Store name'), 'TEST-Kitchen');
    await user.click(screen.getByRole('button', { name: 'Save details' }));
    expect((await screen.findByRole('alert')).textContent).toBe('Names starting with "TEST-" are reserved for Swift’s test accounts. Please choose another name.');
  });

  it('a manager reads the details only, and is told the owner changes them', async () => {
    api({ role: 'MANAGER' });
    renderWithQuery(<StoreDetailsCard storeId="store-1" />);
    expect(await screen.findByRole('heading', { name: 'Sample Kitchen' })).toBeTruthy();
    expect(screen.getByText(STORE_DETAILS_OWNER_ONLY)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Edit name and description' })).toBeNull();
  });

  it('staff see the store, with no editor and no owner line', async () => {
    api({ role: 'STAFF' });
    renderWithQuery(<StoreDetailsCard storeId="store-1" />);
    expect(await screen.findByRole('heading', { name: 'Sample Kitchen' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Edit name and description' })).toBeNull();
    expect(screen.queryByText(STORE_DETAILS_OWNER_ONLY)).toBeNull();
  });
});
