import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import StoreVatPage from './page';
import { mockApi, renderWithQuery, type ApiReply, type ApiRequest } from '@/test/test-utils';

// ---------------------------------------------------------------------------
// [STORE-VAT · owner O-5] The Store VAT queue. A person opens the store's GRA VAT certificate and types what it says
// (number, registered name, effective date) before the store's VAT is approved; approve stays locked until the
// certificate was opened; every decision states a reason; a refusal from the server stays on screen in its words.
// Synthetic store only.
// ---------------------------------------------------------------------------

const REASON = 'Checked the GRA certificate against the store record and the registry';
const row = {
  vendorId: 'vnd-1', name: 'Sample Shop', vatRegistrationNumber: '012345678', mode: 'PRICES_INCLUDE_VAT',
  certificate: { id: 'doc-1', status: 'PENDING', state: 'COMMITTED', createdAt: '2026-10-25T10:00:00.000Z' },
};

function serve(rows: unknown[], onWrite?: (_r: ApiRequest) => ApiReply) {
  return mockApi((r) => {
    if (r.method === 'GET' && r.url.pathname === '/api/v1/admin/store-vat/pending') return { body: { success: true, data: rows } };
    // The viewer accepts only the audited render route for THIS certificate, and checks it loads before unlocking.
    if (r.method === 'GET' && r.url.pathname === '/api/v1/admin/verification/doc-1/document-url') {
      return { body: { success: true, data: { url: '/api/v1/verification/render/doc-1?expires=1&sig=signed' } } };
    }
    if (r.method === 'GET' && r.url.pathname === '/api/v1/verification/render/doc-1') return { body: { loaded: true } };
    if (onWrite && r.method !== 'GET') return onWrite(r);
    throw new Error(`Unexpected request: ${r.method} ${r.url}`);
  });
}

async function openCertificate(user: ReturnType<typeof userEvent.setup>) {
  vi.stubGlobal('open', vi.fn());
  await user.click(await screen.findByRole('button', { name: 'Open the certificate' }));
  await user.click(await screen.findByRole('button', { name: /View document/ }));
  fireEvent.load(await screen.findByRole('img', { name: /evidence/ }));
  await screen.findByRole('button', { name: 'View document again' });
}

afterEach(() => { vi.unstubAllGlobals(); });

describe('[O-5] Store VAT queue', () => {
  // [VAT-DOCS · owner 30 Oct 2026] The reviewer sees what approving does to the store's prices.
  it('each store says how its prices relate to VAT, and an "add VAT" store says approving adds VAT to its prices', async () => {
    serve([row, { ...row, vendorId: 'vnd-2', name: 'Other Shop', mode: 'ADD_VAT_AT_CHECKOUT', certificate: null }]);
    renderWithQuery(<StoreVatPage />);
    expect(await screen.findByText('Prices already include VAT: approving leaves its prices as they are')).toBeTruthy();
    // [REVIEW-F #2256 N1] The reviewer sees the scope: every item the store has not marked zero-rated or exempt.
    expect(screen.getByText('Prices do not include VAT: approving adds VAT to each standard-rated price customers see (every item the store has not marked zero-rated or exempt)')).toBeTruthy();
  });

  it('nothing waiting: says so', async () => {
    serve([]);
    renderWithQuery(<StoreVatPage />);
    expect(await screen.findByText('No store is waiting for a VAT decision.')).toBeTruthy();
  });

  it('a failed read is shown as a failure, never as an empty queue', async () => {
    mockApi(() => ({ status: 500, body: { success: false, error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred' } } }));
    renderWithQuery(<StoreVatPage />);
    await waitFor(() => expect(screen.queryByText('No store is waiting for a VAT decision.')).toBeNull());
    expect(await screen.findByRole('button', { name: /try again|retry/i })).toBeTruthy();
  });

  it('approve is locked until the certificate is opened; then the reviewer types what it says and the server gets exactly that', async () => {
    const user = userEvent.setup();
    const writes: ApiRequest[] = [];
    serve([row], (r) => { writes.push(r); return { body: { success: true, data: { status: 'APPROVED' } } }; });
    renderWithQuery(<StoreVatPage />);
    const approve = await screen.findByRole('button', { name: 'Approve VAT' });
    expect((approve as HTMLButtonElement).disabled).toBe(true);
    await openCertificate(user);
    expect((screen.getByRole('button', { name: 'Approve VAT' }) as HTMLButtonElement).disabled).toBe(false);

    await user.click(screen.getByRole('button', { name: 'Approve VAT' }));
    const dialog = screen.getByRole('dialog', { name: 'Approve VAT for Sample Shop?' });
    // [REVIEW-G #2087 S4-2] The reviewer types what the certificate says; the store's own number is not shown to copy.
    expect(within(dialog).queryByText(/012345678/)).toBeNull();
    await user.type(within(dialog).getByLabelText('VAT registration number on the certificate'), '012345678');
    await user.type(within(dialog).getByLabelText('Registered name on the certificate'), 'Sample Shop Ltd');
    await user.type(within(dialog).getByLabelText('Date it takes effect (YYYY-MM-DD)'), '2026-01-01');
    await user.click(within(dialog).getByRole('radio', { name: /Yes, it is this store/ }));
    await user.type(within(dialog).getByRole('textbox', { name: /reason/i }), REASON);
    await user.click(within(dialog).getByRole('button', { name: 'Approve VAT' }));

    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]!.method).toBe('POST');
    expect(writes[0]!.url.pathname).toBe('/api/v1/admin/store-vat/vnd-1/approve');
    expect(JSON.parse(String(writes[0]!.init?.body))).toEqual({
      certificateDocId: 'doc-1', vatNumber: '012345678', registeredName: 'Sample Shop Ltd', effectiveFrom: '2026-01-01', nameMatchesStore: true,
    });
    expect((writes[0]!.init?.headers as Record<string, string>)['x-swift-reason']).toBe(REASON);
    expect(await screen.findByText(/Sample Shop's VAT is approved/)).toBeTruthy();
  });

  it('the server’s refusal (a number that is not the store’s) stays in the panel, in its words', async () => {
    const user = userEvent.setup();
    serve([row], () => ({ status: 409, body: { success: false, error: { code: 'VAT_NUMBER_MISMATCH', message: 'The number on the certificate is not the number the store gave. Reject it and tell the store, or ask the store to correct its number.' } } }));
    renderWithQuery(<StoreVatPage />);
    await openCertificate(user);
    await user.click(screen.getByRole('button', { name: 'Approve VAT' }));
    const dialog = screen.getByRole('dialog', { name: 'Approve VAT for Sample Shop?' });
    await user.type(within(dialog).getByLabelText('VAT registration number on the certificate'), '999999999');
    await user.type(within(dialog).getByLabelText('Registered name on the certificate'), 'Sample Shop Ltd');
    await user.type(within(dialog).getByLabelText('Date it takes effect (YYYY-MM-DD)'), '2026-01-01');
    await user.click(within(dialog).getByRole('radio', { name: /Yes, it is this store/ }));
    await user.type(within(dialog).getByRole('textbox', { name: /reason/i }), REASON);
    await user.click(within(dialog).getByRole('button', { name: 'Approve VAT' }));
    expect(await within(dialog).findByText(/The number on the certificate is not the number the store gave/)).toBeTruthy();
  });

  it('reject sends the reason the store reads', async () => {
    const user = userEvent.setup();
    const writes: ApiRequest[] = [];
    serve([row], (r) => { writes.push(r); return { body: { success: true, data: { status: 'REJECTED' } } }; });
    renderWithQuery(<StoreVatPage />);
    await user.click(await screen.findByRole('button', { name: 'Reject' }));
    const dialog = screen.getByRole('dialog', { name: 'Do not approve VAT for Sample Shop?' });
    await user.type(within(dialog).getByRole('textbox', { name: /what the store must fix/i }), 'The certificate photo is unreadable, please send a clear photo');
    await user.click(within(dialog).getByRole('button', { name: 'Reject' }));
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]!.url.pathname).toBe('/api/v1/admin/store-vat/vnd-1/reject');
    expect(JSON.parse(String(writes[0]!.init?.body))).toEqual({ reason: 'The certificate photo is unreadable, please send a clear photo' });
  });

  it('a store with no certificate yet cannot be approved', async () => {
    serve([{ ...row, certificate: null }]);
    renderWithQuery(<StoreVatPage />);
    expect(await screen.findByText('No certificate sent yet')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Approve VAT' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByRole('button', { name: 'Open the certificate' })).toBeNull();
  });
});

// [VAT-DOCS · owner ruling 31 Oct 2026] An APPROVED store's change of price choice waits here for a person. Nothing about its
// prices moves until the person approves; a refusal tells the store why and leaves everything as it is.
describe('[VAT-DOCS] an approved store’s change of price choice', () => {
  const change = { vendorId: 'vnd-3', name: 'Approved Shop', vatRegistrationNumber: '012345678', status: 'APPROVED', mode: 'ADD_VAT_AT_CHECKOUT',
    modeRequested: 'PRICES_INCLUDE_VAT', certificate: { id: 'doc-3', status: 'APPROVED', state: 'COMMITTED', createdAt: '2026-10-20T10:00:00.000Z' } };

  it('says what the change does; no certificate step; approve sends the change the reviewer saw', async () => {
    const user = userEvent.setup();
    const writes: ApiRequest[] = [];
    serve([change], (r) => { writes.push(r); return { body: { success: true, data: { status: 'APPROVED' } } }; });
    renderWithQuery(<StoreVatPage />);
    expect(await screen.findByText('Asks to change to “prices already include VAT”: approving takes the added VAT off, so customers pay the prices the store typed.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Open the certificate' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Approve VAT' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Approve the change' }));
    const dialog = screen.getByRole('dialog', { name: 'Approve Approved Shop’s price change?' });
    await user.type(within(dialog).getByRole('textbox', { name: /reason/i }), REASON);
    await user.click(within(dialog).getByRole('button', { name: 'Approve the change' }));
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]!.url.pathname).toBe('/api/v1/admin/store-vat/vnd-3/mode');
    expect(JSON.parse(String(writes[0]!.init?.body))).toEqual({ approve: true, mode: 'PRICES_INCLUDE_VAT', reason: REASON });
    expect(await screen.findByText(/Approved Shop's price change is approved/)).toBeTruthy();
  });

  it('refusing sends the reason the store reads; the words for a change to "add VAT" name the scope', async () => {
    const user = userEvent.setup();
    const writes: ApiRequest[] = [];
    serve([{ ...change, mode: 'PRICES_INCLUDE_VAT', modeRequested: 'ADD_VAT_AT_CHECKOUT' }], (r) => { writes.push(r); return { body: { success: true, data: { status: 'APPROVED' } } }; });
    renderWithQuery(<StoreVatPage />);
    expect(await screen.findByText('Asks to change to “prices do not include VAT”: approving adds VAT to each standard-rated price its customers see (every item it has not marked zero-rated or exempt).')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Refuse the change' }));
    const dialog = screen.getByRole('dialog', { name: 'Refuse Approved Shop’s price change?' });
    await user.type(within(dialog).getByRole('textbox', { name: /what the store reads/i }), 'Most of the shelf is zero-rated, keep prices as they are');
    await user.click(within(dialog).getByRole('button', { name: 'Refuse the change' }));
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]!.url.pathname).toBe('/api/v1/admin/store-vat/vnd-3/mode');
    expect(JSON.parse(String(writes[0]!.init?.body))).toEqual({ approve: false, mode: 'ADD_VAT_AT_CHECKOUT', reason: 'Most of the shelf is zero-rated, keep prices as they are' });
  });
});
