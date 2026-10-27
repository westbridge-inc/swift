import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import InventoryPage from './page';
import { OUTSIDE_PHOTO_NOTE } from './menu-tools';
import { mockApi, renderWithQuery, type ApiRequest } from '@/test/test-utils';

// ---------------------------------------------------------------------------
// [TAP-AUDIT 27 Oct · owner rule 11 Oct: the website copies the app] The web Products page now does what the phone's
// Products tab does: add an item (photo, description, options and add-ons, section, availability, stock, bulk), edit
// it, delete it, and add / rename / delete sections — with the app's fields, words and server calls.
//
// Before, the page said "Photos, descriptions, options and new single items are managed in the Swift app": a store on a
// computer could only switch items on/off, change a price and bulk-import a spreadsheet.
// ---------------------------------------------------------------------------

type Row = Record<string, unknown> & { id: string; name: string };
let items: Row[];
let sections: Array<{ id: string; name: string }>;
let role: string;
let vendorType: string;
let writes: ApiRequest[];
let refuse: Record<string, { status: number; body: unknown }>;
let hold: { release?: () => void } | null;
/** After the first load: every re-read of the list hangs, so only the server's answers can change the screen. */
let holdReads: boolean;
/** [REVIEW-F #2142] Writes that hang (a slow line): to prove a second press sends nothing while the first is out. */
let holdSectionPost = false;
let holdItemPost = false;

const body = (r: ApiRequest) => (typeof r.init?.body === 'string' ? JSON.parse(r.init.body) : r.init?.body);

beforeEach(() => {
  items = [
    { id: 'rice', name: 'Rice 20 kg', basePrice: '6000.00', categoryId: 'staples', category: { id: 'staples', name: 'Staples' }, isAvailable: true,
      stockQuantity: null, bulk: 'very_bulky', description: 'Parboiled', optionGroups: [] },
    { id: 'roti', name: 'Roti', basePrice: '500.00', categoryId: 'mains', category: { id: 'mains', name: 'Mains' }, isAvailable: true, stockQuantity: null, bulk: 'normal',
      imageUrl: 'items/store-1/abcdefghijklmnop.jpg',
      optionGroups: [{ id: 'g-size', name: 'Size', isRequired: true, minSelect: 1, maxSelect: 1, options: [{ id: 'o-small', name: 'Small', additionalPrice: '0' }] }] },
  ];
  sections = [{ id: 'staples', name: 'Staples' }, { id: 'mains', name: 'Mains' }];
  role = 'OWNER';
  vendorType = 'SUPERMARKET';
  writes = [];
  refuse = {};
  hold = null;
  holdReads = false;
  holdSectionPost = false;
  holdItemPost = false;
  mockApi(async (r) => {
    const { url, method } = r;
    const path = url.pathname;
    if (method !== 'GET') writes.push(r);
    const refused = refuse[`${method} ${path}`];
    if (refused) return refused;
    if ((path === '/api/v1/vendor/items' || path === '/api/v1/vendor/categories') && method === 'GET' && holdReads) return new Promise<never>(() => {});
    if (path === '/api/v1/vendor/items' && method === 'GET') return { body: { data: items } };
    if (path === '/api/v1/vendor/categories' && method === 'GET') return { body: { data: sections } };
    if (path === '/api/v1/vendor/stores') return { body: { data: { stores: [{ id: 'store-1', name: 'Mart', vendorType, isCurrentlyOpen: true, acceptingOrders: true, city: null, isVerified: true }], selectedId: 'store-1', myRole: role } } };
    if (path === '/api/v1/vendor/profile') return { body: { data: { myRole: role, vendors: [] } } };
    if (path === '/api/v1/vendor/items' && method === 'POST' && holdItemPost) return new Promise<never>(() => {});
    if (path === '/api/v1/vendor/items' && method === 'POST') {
      const b = body(r);
      const saved = { id: 'new-1', ...b, basePrice: String(b.basePrice), category: sections.find((c) => c.id === b.categoryId), bulk: b.bulk ?? 'normal',
        optionGroups: (b.optionGroups ?? []).map((g: Row, gi: number) => ({ ...g, id: `g-${gi}`, options: (g['options'] as Row[]).map((o, oi) => ({ ...o, id: `o-${gi}-${oi}` })) })) };
      items = [...items, saved];
      return { body: { data: saved } };
    }
    const image = path.match(/^\/api\/v1\/vendor\/items\/([^/]+)\/image$/);
    if (image && method === 'POST') return { body: { data: { id: image[1], imageUrl: `items/store-1/${image[1]}-photo-000000`.slice(0, 31) } } };
    const one = path.match(/^\/api\/v1\/vendor\/items\/([^/]+)$/);
    if (one && method === 'PUT') {
      if (hold) await new Promise<void>((resolve) => { hold!.release = resolve; });
      const row = items.find((i) => i.id === one[1])!;
      const saved = { ...row, ...body(r), basePrice: String(body(r).basePrice ?? row['basePrice']) };
      items = items.map((i) => (i.id === one[1] ? saved : i));
      return { body: { data: saved } };
    }
    if (one && method === 'DELETE') { items = items.filter((i) => i.id !== one[1]); return { body: { data: { deleted: true } } }; }
    const groups = path.match(/^\/api\/v1\/vendor\/items\/([^/]+)\/option-groups$/);
    if (groups) return { body: { data: { id: 'g-new', ...body(r), options: [] } } };
    const opts = path.match(/^\/api\/v1\/vendor\/option-groups\/([^/]+)\/options$/);
    if (opts) return { body: { data: { id: 'o-new', optionGroupId: opts[1], ...body(r) } } };
    if (/^\/api\/v1\/vendor\/options\/[^/]+$/.test(path)) return { body: { data: { deleted: true } } };
    if (path === '/api/v1/vendor/categories' && method === 'POST' && holdSectionPost) return new Promise<never>(() => {});
    if (path === '/api/v1/vendor/categories' && method === 'POST') {
      const saved = { id: 'sides', name: body(r).name, sortOrder: 2 };
      sections = [...sections, saved];
      return { body: { data: saved } };
    }
    const section = path.match(/^\/api\/v1\/vendor\/categories\/([^/]+)$/);
    if (section && method === 'PUT') { sections = sections.map((c) => (c.id === section[1] ? { ...c, name: body(r).name } : c)); return { body: { data: sections.find((c) => c.id === section[1]) } }; }
    if (section && method === 'DELETE') {
      sections = sections.filter((c) => c.id !== section[1]);
      items = items.filter((i) => (i['category'] as { id: string }).id !== section[1]);
      return { body: { data: { deleted: true, itemsRemoved: 1 } } };
    }
    throw new Error(`Unexpected request: ${method} ${url}`);
  });
});

const dialog = () => screen.findByRole('dialog');
const field = (scope: HTMLElement, label: string) => within(scope).getByLabelText(label) as HTMLInputElement;
async function type(scope: HTMLElement, label: string, value: string) {
  await act(async () => { fireEvent.change(field(scope, label), { target: { value } }); });
}
async function click(el: HTMLElement) { await act(async () => { fireEvent.click(el); }); }

describe('[TAP-AUDIT] the web adds and edits items like the app', () => {
  it('Add item: photo, name, price, one option group with its choices — ONE create request, then the photo; the row is there at once', async () => {
    renderWithQuery(<InventoryPage />);
    await screen.findByRole('article', { name: 'Roti' });
    await click(await screen.findByRole('button', { name: '+ Add item' }));
    const editor = await dialog();
    expect(within(editor).getByRole('heading', { name: 'New Item' })).toBeTruthy();
    await type(editor, 'Item name', 'Chow mein');
    await type(editor, 'Price (GYD)', '700');
    const file = new File(['jpeg-bytes'], 'chow.jpg', { type: 'image/jpeg' });
    await act(async () => { fireEvent.change(field(editor, 'Item photo'), { target: { files: [file] } }); });
    await type(editor, 'New group (e.g. Size, Toppings)', 'Size');
    await click(within(editor).getByRole('button', { name: 'Required' }));
    await click(within(editor).getByRole('button', { name: 'Add option group' }));
    const group = within(editor).getByRole('group', { name: 'Group Size' });
    await type(group, 'Choice for Size', 'Small');
    await click(within(group).getByRole('button', { name: 'Add choice to Size' }));
    await type(group, 'Choice for Size', 'Large');
    await type(group, 'Extra price for Size', '200');
    await click(within(group).getByRole('button', { name: 'Add choice to Size' }));
    expect(writes, 'nothing is sent before Add item').toHaveLength(0);
    await click(within(editor).getByRole('button', { name: 'Mains' }));
    await click(within(editor).getByRole('button', { name: 'Add item' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(writes.map((w) => `${w.method} ${w.url.pathname}`)).toEqual(['POST /api/v1/vendor/items', 'POST /api/v1/vendor/items/new-1/image']);
    expect(body(writes[0]!)).toMatchObject({
      categoryId: 'mains', name: 'Chow mein', basePrice: 700, isAvailable: true, bulk: 'normal',
      optionGroups: [{ name: 'Size', isRequired: true, minSelect: 1, maxSelect: 1, options: [{ name: 'Small', additionalPrice: 0 }, { name: 'Large', additionalPrice: 200 }] }],
    });
    expect((writes[1]!.init?.body as FormData).get('file')).toBeTruthy();
    expect(await screen.findByRole('article', { name: 'Chow mein' })).toBeTruthy();
  });

  it('Edit item opens with the item as saved (bulk kept), sends the edit, and a choice added or removed goes to the server at once', async () => {
    renderWithQuery(<InventoryPage />);
    const rice = await screen.findByRole('article', { name: 'Rice 20 kg' });
    await click(await within(rice).findByRole('button', { name: 'Edit item' }));
    const editor = await dialog();
    expect(within(editor).getByRole('heading', { name: 'Edit Item' })).toBeTruthy();
    expect(field(editor, 'Item name').value).toBe('Rice 20 kg');
    expect(field(editor, 'Price (GYD)').value).toBe('6000');
    expect(field(editor, 'Description (optional)').value).toBe('Parboiled');
    expect(within(editor).getByRole('radio', { name: 'Very bulky' }).getAttribute('aria-checked')).toBe('true');
    await type(editor, 'Price (GYD)', '6200');
    await click(within(editor).getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(writes.map((w) => `${w.method} ${w.url.pathname}`)).toEqual(['PUT /api/v1/vendor/items/rice']);
    expect(body(writes[0]!)).toMatchObject({ basePrice: 6200, bulk: 'very_bulky', name: 'Rice 20 kg', categoryId: 'staples' });
    expect(body(writes[0]!)).not.toHaveProperty('optionGroups');

    const roti = screen.getByRole('article', { name: 'Roti' });
    await click(within(roti).getByRole('button', { name: 'Edit item' }));
    const second = await dialog();
    const size = within(second).getByRole('group', { name: 'Group Size' });
    await type(size, 'Choice for Size', 'Large');
    await type(size, 'Extra price for Size', '200');
    await click(within(size).getByRole('button', { name: 'Add choice to Size' }));
    await waitFor(() => expect(within(size).getByText('Large')).toBeTruthy());
    await click(within(size).getByRole('button', { name: 'Remove Small' }));
    await waitFor(() => expect(within(size).queryByText('Small')).toBeNull());
    expect(writes.slice(1).map((w) => `${w.method} ${w.url.pathname}`)).toEqual(['POST /api/v1/vendor/option-groups/g-size/options', 'DELETE /api/v1/vendor/options/o-small']);
    expect(body(writes[1]!)).toEqual({ name: 'Large', additionalPrice: 200 });
  });

  it('Delete asks once ("Delete item?"), then the row leaves', async () => {
    renderWithQuery(<InventoryPage />);
    const rice = await screen.findByRole('article', { name: 'Rice 20 kg' });
    await click(await within(rice).findByRole('button', { name: 'Delete' }));
    const ask = await dialog();
    expect(within(ask).getByText('Remove "Rice 20 kg" from your menu.')).toBeTruthy();
    await click(within(ask).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(screen.queryByRole('article', { name: 'Rice 20 kg' })).toBeNull());
    expect(writes.map((w) => `${w.method} ${w.url.pathname}`)).toEqual(['DELETE /api/v1/vendor/items/rice']);
  });

  it('a refused save says why in the server\'s words, and the editor stays open', async () => {
    refuse['POST /api/v1/vendor/items'] = { status: 409, body: { success: false, error: { code: 'PROHIBITED_ITEM', message: 'Swift doesn\'t allow this item: alcohol.' } } };
    renderWithQuery(<InventoryPage />);
    await screen.findByRole('article', { name: 'Roti' });
    await click(await screen.findByRole('button', { name: '+ Add item' }));
    const editor = await dialog();
    await type(editor, 'Item name', 'Rum punch');
    await type(editor, 'Price (GYD)', '900');
    await click(within(editor).getByRole('button', { name: 'Add item' }));
    expect(await within(editor).findByRole('alert')).toBeTruthy();
    expect(within(editor).getByRole('alert').textContent).toBe('Swift doesn\'t allow this item: alcohol.');
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('a services store books appointments: the editor sends the booking set-up, never options', async () => {
    vendorType = 'SERVICE';
    renderWithQuery(<InventoryPage />);
    await screen.findByRole('article', { name: 'Roti' });
    await click(await screen.findByRole('button', { name: '+ Add item' }));
    const editor = await dialog();
    expect(within(editor).getByText('Appointment booking')).toBeTruthy();
    expect(within(editor).queryByLabelText('New group (e.g. Size, Toppings)')).toBeNull();
    await type(editor, 'Item name', 'Haircut');
    await type(editor, 'Price (GYD)', '2000');
    await click(within(editor).getByRole('button', { name: '45 min' }));
    await click(within(editor).getByRole('button', { name: 'Add item' }));
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(body(writes[0]!)).toMatchObject({ fulfillment: 'APPOINTMENT', bookingConfig: { durationMinutes: 45, serviceMode: 'AT_BUSINESS', slots: expect.any(Array) } });
    expect(body(writes[0]!)).not.toHaveProperty('optionGroups');
  });

  it('[REVIEW-G #2142 S4-3] an outside address on a row draws nothing (only a photo Swift keeps)', async () => {
    items = items.map((i) => (i.id === 'rice' ? { ...i, imageUrl: 'https://elsewhere.example/rice.jpg' } : i));
    renderWithQuery(<InventoryPage />);
    const roti = await screen.findByRole('article', { name: 'Roti' });
    await waitFor(() => expect(roti.querySelector('img')).toBeTruthy());
    expect(screen.getByRole('article', { name: 'Rice 20 kg' }).querySelector('img')).toBeNull();
  });

  it('[REVIEW-F #2142 S4-1] that row says why, in the app\'s words; a photo Swift keeps, or none, says nothing', async () => {
    items = items.map((i) => (i.id === 'rice' ? { ...i, imageUrl: 'https://elsewhere.example/rice.jpg' } : i));
    renderWithQuery(<InventoryPage />);
    const rice = await screen.findByRole('article', { name: 'Rice 20 kg' });
    expect(await within(rice).findByText(OUTSIDE_PHOTO_NOTE)).toBeTruthy();
    expect(within(screen.getByRole('article', { name: 'Roti' })).queryByText(OUTSIDE_PHOTO_NOTE)).toBeNull();
    const app = readFileSync(join(process.cwd(), '..', 'mobile', 'src', 'modules', 'vendor', 'screens', 'VendorMenuScreen.tsx'), 'utf8');
    expect(app, 'the same words as the app').toContain(`OUTSIDE_PHOTO_NOTE = ${JSON.stringify(OUTSIDE_PHOTO_NOTE)}`);
  });

  it('an item\'s own photo is on its row (a small copy from the store-photo route)', async () => {
    renderWithQuery(<InventoryPage />);
    const roti = await screen.findByRole('article', { name: 'Roti' });
    const img = roti.querySelector('img');
    expect(img?.getAttribute('src')).toBe('/media/items/store-1/abcdefghijklmnop.jpg?w=96');
  });
});

describe('[TAP-AUDIT] sections like the app: chips with counts, add, rename, delete', () => {
  it('the chips count each section; Add section, Rename and Delete (asking with the item count) go to the server', async () => {
    renderWithQuery(<InventoryPage />);
    await screen.findByRole('article', { name: 'Roti' });
    const chips = screen.getByLabelText('Sections');
    await waitFor(() => expect(within(chips).getAllByRole('button').map((b) => b.textContent)).toEqual(['All · 2', 'Staples · 1', 'Mains · 1', '+ Add section']));
    holdReads = true; // from here only the server's answers move the screen
    expect(screen.getByRole('region', { name: 'Staples' })).toBeTruthy();

    await click(within(chips).getByRole('button', { name: '+ Add section' }));
    let box = await dialog();
    expect(field(box, 'Section name').placeholder).toBe('e.g. Produce, Dairy, Household');
    await type(box, 'Section name', 'Sides');
    await click(within(box).getByRole('button', { name: 'Add section' }));
    await waitFor(() => expect(within(screen.getByLabelText('Sections')).getByRole('button', { name: 'Sides · 0' })).toBeTruthy());

    await click(screen.getByRole('button', { name: 'Rename Mains' }));
    box = await dialog();
    await type(box, 'Section name', 'Main dishes');
    await click(within(box).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.getByRole('region', { name: 'Main dishes' })).toBeTruthy());

    await click(screen.getByRole('button', { name: 'Delete Staples' }));
    box = await dialog();
    expect(within(box).getByText('This removes the section AND its 1 item from your menu.')).toBeTruthy();
    await click(within(box).getByRole('button', { name: 'Delete section + 1 item' }));
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Staples' })).toBeNull());
    expect(screen.queryByRole('article', { name: 'Rice 20 kg' })).toBeNull();
    expect(writes.map((w) => `${w.method} ${w.url.pathname}`)).toEqual([
      'POST /api/v1/vendor/categories', 'PUT /api/v1/vendor/categories/mains', 'DELETE /api/v1/vendor/categories/staples',
    ]);
  });

  it('staff switch items on and off only: no Add item, Edit, Delete or section tools (as in the app)', async () => {
    role = 'STAFF';
    renderWithQuery(<InventoryPage />);
    const roti = await screen.findByRole('article', { name: 'Roti' });
    await waitFor(() => expect(within(roti).getByRole('switch')).toBeTruthy());
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByRole('button', { name: '+ Add item' })).toBeNull();
    expect(within(roti).queryByRole('button', { name: 'Edit item' })).toBeNull();
    expect(within(roti).queryByRole('button', { name: 'Delete' })).toBeNull();
    expect(screen.queryByRole('button', { name: '+ Add section' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Rename Mains' })).toBeNull();
  });
});

describe('[TAP-AUDIT] a new price shows at the tap', () => {
  it('the row shows the new price before the server answers; only that row waits', async () => {
    hold = {};
    renderWithQuery(<InventoryPage />);
    const roti = await screen.findByRole('article', { name: 'Roti' });
    await click(within(roti).getByRole('button', { name: '$500' }));
    await act(async () => { fireEvent.change(within(roti).getByRole('spinbutton'), { target: { value: '650' } }); });
    await act(async () => { fireEvent.keyDown(within(roti).getByRole('spinbutton'), { key: 'Enter' }); });
    await waitFor(() => expect(writes).toHaveLength(1));
    const now = screen.getByRole('article', { name: 'Roti' });
    expect(within(now).getByRole('button', { name: '$650' }).hasAttribute('disabled')).toBe(true);
    expect(within(screen.getByRole('article', { name: 'Rice 20 kg' })).getByRole('button', { name: '$6,000' }).hasAttribute('disabled')).toBe(false);
    await act(async () => { hold!.release!(); });
    await waitFor(() => expect(within(screen.getByRole('article', { name: 'Roti' })).getByRole('button', { name: '$650' }).hasAttribute('disabled')).toBe(false));
  });

  it('a refused price goes back to the old one and says why', async () => {
    refuse['PUT /api/v1/vendor/items/roti'] = { status: 409, body: { success: false, error: { code: 'ITEM_LOCKED', message: 'This item is being checked by Swift.' } } };
    renderWithQuery(<InventoryPage />);
    const roti = await screen.findByRole('article', { name: 'Roti' });
    holdReads = true; // only the refusal itself can put the old price back
    await click(within(roti).getByRole('button', { name: '$500' }));
    await act(async () => { fireEvent.change(within(roti).getByRole('spinbutton'), { target: { value: '650' } }); });
    await act(async () => { fireEvent.keyDown(within(roti).getByRole('spinbutton'), { key: 'Enter' }); });
    expect(await screen.findByText(/This item is being checked by Swift\./)).toBeTruthy();
    await waitFor(() => expect(within(screen.getByRole('article', { name: 'Roti' })).getByRole('button', { name: '$500' })).toBeTruthy());
  });
});

describe('[REVIEW-F #2142] a second press while the first is on its way sends nothing more', () => {
  // S3-2: REVIEW-F's probe, lifted as is (Enter, then a key-repeat 30 ms later).
  it('Enter twice in the section name: ONE new section', async () => {
    holdSectionPost = true;
    renderWithQuery(<InventoryPage />);
    await screen.findByRole('article', { name: 'Roti' });
    await click(within(screen.getByLabelText('Sections')).getByRole('button', { name: '+ Add section' }));
    const box = await dialog();
    await type(box, 'Section name', 'Sides');
    await act(async () => { fireEvent.keyDown(field(box, 'Section name'), { key: 'Enter' }); });
    await act(async () => { await new Promise((r) => setTimeout(r, 30)); }); // a key-repeat later: React has drawn the pending state
    await act(async () => { fireEvent.keyDown(field(box, 'Section name'), { key: 'Enter' }); });
    await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
    expect(writes.filter((w) => w.method === 'POST' && w.url.pathname === '/api/v1/vendor/categories')).toHaveLength(1);
  });

  // S4-1: Save is held while it saves.
  it('Add item pressed twice: ONE create request', async () => {
    holdItemPost = true;
    renderWithQuery(<InventoryPage />);
    await screen.findByRole('article', { name: 'Roti' });
    await click(await screen.findByRole('button', { name: '+ Add item' }));
    const editor = await dialog();
    await type(editor, 'Item name', 'Chow mein');
    await type(editor, 'Price (GYD)', '700');
    await click(within(editor).getByRole('button', { name: 'Add item' }));
    const saving = await within(editor).findByRole('button', { name: 'Saving…' });
    expect(saving.hasAttribute('disabled')).toBe(true);
    await click(saving);
    await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
    expect(writes.filter((w) => w.method === 'POST' && w.url.pathname === '/api/v1/vendor/items')).toHaveLength(1);
  });
});

describe('[REVIEW-F #2142 S4-4] the editor draws only a photo Swift keeps, or the file just chosen', () => {
  it('an outside address saved before photos were uploaded is not drawn ("Add a photo"); Swift\'s own photo is', async () => {
    items = items.map((i) => (i.id === 'rice' ? { ...i, imageUrl: 'https://elsewhere.example/rice.jpg' } : i));
    renderWithQuery(<InventoryPage />);
    const rice = await screen.findByRole('article', { name: 'Rice 20 kg' });
    await click(await within(rice).findByRole('button', { name: 'Edit item' }));
    let editor = await dialog();
    expect(editor.querySelector('img')).toBeNull();
    expect(within(editor).getByText('Add a photo')).toBeTruthy();
    expect(within(editor).getByText(OUTSIDE_PHOTO_NOTE), '[REVIEW-F #2142 S4-1] and says why').toBeTruthy();
    await click(within(editor).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await click(within(screen.getByRole('article', { name: 'Roti' })).getByRole('button', { name: 'Edit item' }));
    editor = await dialog();
    expect(editor.querySelector('img')?.getAttribute('src')).toContain('/media/items/store-1/abcdefghijklmnop.jpg');
    expect(within(editor).getByText('Change photo')).toBeTruthy();
    expect(within(editor).queryByText(OUTSIDE_PHOTO_NOTE)).toBeNull();
  });
});

describe('[REVIEW-F #2142 S4-2] a removed item or section is said in plain words', () => {
  it('deleting an item already deleted on the phone: plain words, never the internal id', async () => {
    refuse['DELETE /api/v1/vendor/items/rice'] = { status: 404, body: { success: false, error: { code: 'NOT_FOUND', message: 'Item with id cm0abc123 not found' } } };
    renderWithQuery(<InventoryPage />);
    const rice = await screen.findByRole('article', { name: 'Rice 20 kg' });
    await click(await within(rice).findByRole('button', { name: 'Delete' }));
    const ask = await dialog();
    await click(within(ask).getByRole('button', { name: 'Delete' }));
    expect((await within(ask).findByRole('alert')).textContent).toBe('This section or item was removed on another phone. Go back and open the menu again.');
  });
});
