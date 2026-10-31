import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithQuery } from '@/test/test-utils';
import * as vendorApi from '@/lib/vendor-api';
import * as storeVatApi from '@/lib/store-vat-api';
import * as storeVatRead from '@/lib/store-vat-read';
import type { StoreVatView } from '@/lib/store-vat-read';
import { VatCard, vatStatusLine } from './vat-card';

// ---------------------------------------------------------------------------
// [STORE-VAT · owner O-5] The store's VAT on the web dashboard. The owner says whether the business is VAT-registered
// with the GRA, gives the number on the certificate and sends the certificate; a PERSON at Swift checks it. Owner only;
// hidden while Swift's VAT switch is off (unless there is a record to show); the words never promise VAT before a person
// approved it; the certificate upload carries the recorded consent words. Synthetic store only.
// ---------------------------------------------------------------------------

const view = (over: Partial<StoreVatView> = {}): StoreVatView => ({
  available: true, status: 'NONE', mode: null, vatRegistrationNumber: null, effective: false, approved: null, reviewNote: null,
  certificate: null, ratePercent: 14, modesOffered: ['PRICES_INCLUDE_VAT'], sources: [], ...over,
});
const owner = { myRole: 'OWNER', vendors: [{ id: 'store-1', name: 'Sample Shop' }] };
const manager = { myRole: 'MANAGER', vendors: [{ id: 'store-1', name: 'Sample Shop' }] };

function setup(profile: unknown, vat: StoreVatView) {
  vi.spyOn(vendorApi, 'getProfile').mockResolvedValue(profile as never);
  vi.spyOn(storeVatRead, 'getStoreVat').mockResolvedValue(vat);
  return renderWithQuery(<VatCard storeId="store-1" />);
}
afterEach(() => { vi.restoreAllMocks(); });

describe('[O-5] who sees the VAT card', () => {
  it('a manager never sees it (the business’s tax registration is the owner’s to give)', async () => {
    setup(manager, view());
    await waitFor(() => expect(vendorApi.getProfile).toHaveBeenCalled());
    expect(storeVatRead.getStoreVat).not.toHaveBeenCalled();
    expect(screen.queryByText('VAT')).toBeNull();
  });

  it('hidden while Swift’s VAT switch is off and the store never claimed VAT', async () => {
    setup(owner, view({ available: false }));
    await waitFor(() => expect(storeVatRead.getStoreVat).toHaveBeenCalled());
    expect(screen.queryByText('Is your business VAT-registered with the GRA?')).toBeNull();
    expect(screen.queryByRole('heading', { name: 'VAT' })).toBeNull();
  });

  it('switch off with a record: the status shows and the owner can still turn VAT off (asked once for an approved store)', async () => {
    setup(owner, view({ available: false, status: 'APPROVED', effective: false, vatRegistrationNumber: '012345678' }));
    vi.spyOn(storeVatApi, 'updateStoreVat').mockResolvedValue(view({ available: false }));
    await userEvent.click(await screen.findByRole('button', { name: 'Turn VAT off' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/ends your approval/);
    expect(storeVatApi.updateStoreVat).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Turn VAT off' }));
    await waitFor(() => expect(storeVatApi.updateStoreVat).toHaveBeenCalledWith({ registered: false }));
    expect(screen.queryByText('Is your business VAT-registered with the GRA?')).toBeNull();
  });
});

describe('[O-5] the owner’s answer', () => {
  // [VAT-DOCS · owner 30 Oct 2026] The optional document, one submission: number + price choice + certificate together.
  it('it is the optional "VAT certificate (only if VAT-registered)" document, never needed to go live', async () => {
    setup(owner, view());
    expect(await screen.findByText(/Optional document: VAT certificate \(only if VAT-registered\)\./)).toBeTruthy();
    expect(screen.getByText(/You do not need it to go live\./)).toBeTruthy();
  });

  it('a first claim: Yes + the number + how the prices relate to VAT + the certificate, sent in ONE submission', async () => {
    setup(owner, view());
    vi.spyOn(storeVatApi, 'updateStoreVat');
    vi.spyOn(storeVatApi, 'sendVatCertificate').mockResolvedValue(view({ status: 'PENDING', mode: 'ADD_VAT_AT_CHECKOUT', vatRegistrationNumber: '012345678',
      certificate: { id: 'doc-1', status: 'PENDING', state: 'COMMITTED', reviewNote: null, createdAt: '2026-10-25T00:00:00Z', reviewedAt: null } }));
    expect(await screen.findByText('Not VAT-registered: your prices and receipts show no VAT.')).toBeTruthy();
    await userEvent.click(screen.getByRole('radio', { name: 'Yes' }));
    // No separate save: the claim goes with its certificate.
    expect(screen.queryByRole('button', { name: 'Save and send for checking' })).toBeNull();
    const choose = screen.getByRole('button', { name: 'Choose the certificate and send' });
    await userEvent.click(screen.getByRole('checkbox'));
    expect((choose as HTMLButtonElement).disabled).toBe(true); // no number and no price choice yet
    expect(screen.getByText('Type your VAT number and choose how your prices relate to VAT first.')).toBeTruthy();
    await userEvent.type(screen.getByLabelText('VAT registration number (exactly as on your GRA certificate)'), ' 012345678 ');
    expect((choose as HTMLButtonElement).disabled).toBe(true); // still no price choice
    await userEvent.click(screen.getByRole('radio', { name: 'My prices do not include VAT' }));
    expect(screen.getByText(/Swift adds 14% VAT to the price you type for each standard-rated item, so customers see and pay the full price, VAT included, before they order/)).toBeTruthy();
    expect((choose as HTMLButtonElement).disabled).toBe(false);
    const file = new File(['%PDF-1.4'], 'certificate.pdf', { type: 'application/pdf' });
    await userEvent.upload(screen.getByLabelText('VAT certificate file'), file);
    await waitFor(() => expect(storeVatApi.sendVatCertificate).toHaveBeenCalledWith(file, { vatRegistrationNumber: '012345678', mode: 'ADD_VAT_AT_CHECKOUT' }));
    expect(storeVatApi.updateStoreVat).not.toHaveBeenCalled();
    expect(await screen.findByText(/waiting for a person at Swift to check it/)).toBeTruthy();
  });

  it('a store that already said yes changes how its prices relate to VAT', async () => {
    setup(owner, view({ status: 'PENDING', mode: 'PRICES_INCLUDE_VAT', vatRegistrationNumber: '012345678' }));
    vi.spyOn(storeVatApi, 'updateStoreVat').mockResolvedValue(view({ status: 'PENDING', mode: 'ADD_VAT_AT_CHECKOUT', vatRegistrationNumber: '012345678' }));
    const save = await screen.findByRole('button', { name: 'Save and send for checking' });
    expect((save as HTMLButtonElement).disabled).toBe(true); // nothing changed yet
    await userEvent.click(screen.getByRole('radio', { name: 'My prices do not include VAT' }));
    await userEvent.click(save);
    await waitFor(() => expect(storeVatApi.updateStoreVat).toHaveBeenCalledWith({ registered: true, vatRegistrationNumber: '012345678', mode: 'ADD_VAT_AT_CHECKOUT' }));
  });

  it('No on a store that claimed VAT turns it off', async () => {
    setup(owner, view({ status: 'PENDING', mode: 'PRICES_INCLUDE_VAT', vatRegistrationNumber: '012345678' }));
    vi.spyOn(storeVatApi, 'updateStoreVat').mockResolvedValue(view());
    await userEvent.click(await screen.findByRole('radio', { name: 'No' }));
    await userEvent.click(screen.getByRole('button', { name: 'Turn VAT off' }));
    await waitFor(() => expect(storeVatApi.updateStoreVat).toHaveBeenCalledWith({ registered: false }));
  });

  // [REVIEW-F #2087 S4] Re-approval needs a person: turning off an APPROVED store's VAT asks once, in words.
  it('No on an APPROVED store asks once before turning VAT off', async () => {
    setup(owner, view({ status: 'APPROVED', effective: true, mode: 'PRICES_INCLUDE_VAT', vatRegistrationNumber: '012345678',
      approved: { number: '012345678', registeredName: 'Sample Shop Ltd', effectiveFrom: '2026-01-01T00:00:00.000Z', reviewedAt: null } }));
    vi.spyOn(storeVatApi, 'updateStoreVat').mockResolvedValue(view());
    await userEvent.click(await screen.findByRole('radio', { name: 'No' }));
    await userEvent.click(screen.getByRole('button', { name: 'Turn VAT off' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/a person at Swift must check your certificate again/);
    expect(storeVatApi.updateStoreVat).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Turn VAT off' }));
    await waitFor(() => expect(storeVatApi.updateStoreVat).toHaveBeenCalledWith({ registered: false }));
  });

  it('a refusal is shown in the server’s own words', async () => {
    setup(owner, view({ status: 'PENDING', mode: 'PRICES_INCLUDE_VAT', vatRegistrationNumber: '012345678' }));
    vi.spyOn(storeVatApi, 'updateStoreVat').mockRejectedValue(new Error('Type your VAT registration number exactly as it is on your GRA certificate.'));
    const field = await screen.findByLabelText('VAT registration number (exactly as on your GRA certificate)');
    await userEvent.clear(field);
    await userEvent.type(field, 'abc');
    await userEvent.click(screen.getByRole('button', { name: 'Save and send for checking' }));
    expect((await screen.findByRole('alert')).textContent).toBe('Type your VAT registration number exactly as it is on your GRA certificate.');
  });
});

describe('[O-5] the certificate', () => {
  it('the file can be chosen only after the consent tick, and goes to the store’s VAT route', async () => {
    setup(owner, view({ status: 'PENDING', mode: 'PRICES_INCLUDE_VAT', vatRegistrationNumber: '012345678' }));
    vi.spyOn(storeVatApi, 'sendVatCertificate').mockResolvedValue(view({ status: 'PENDING', certificate: { id: 'doc-1', status: 'PENDING', state: 'COMMITTED', reviewNote: null, createdAt: '2026-10-25T00:00:00Z', reviewedAt: null } }));
    const choose = await screen.findByRole('button', { name: 'Choose the certificate' });
    expect((choose as HTMLButtonElement).disabled).toBe(true);
    await userEvent.click(screen.getByRole('checkbox'));
    expect((choose as HTMLButtonElement).disabled).toBe(false);
    const file = new File(['%PDF-1.4'], 'certificate.pdf', { type: 'application/pdf' });
    await userEvent.upload(screen.getByLabelText('VAT certificate file'), file);
    // A store that already said yes sends the certificate alone (its number and choice are on file).
    await waitFor(() => expect(storeVatApi.sendVatCertificate).toHaveBeenCalledWith(file, undefined));
    expect(await screen.findByText(/waiting for a person at Swift to check it/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Choose the certificate' })).toBeNull();
  });

  it('the consent words are the API’s recorded document_v1 words, word for word', async () => {
    const api = readFileSync(join(process.cwd(), '..', 'api', 'src', 'modules', 'verification', 'upload-consent.ts'), 'utf8');
    const apiText = /document_v1: \{[\s\S]*?text: '([^']+)'/.exec(api)?.[1];
    // Read from the card as the store owner sees it (the tick's whole label, the privacy-notice link's words included).
    setup(owner, view({ status: 'PENDING', mode: 'PRICES_INCLUDE_VAT', vatRegistrationNumber: '012345678' }));
    const label = (await screen.findByRole('checkbox')).closest('label')?.textContent?.replace(/\s+/g, ' ').trim();
    expect(apiText).toBeTruthy();
    expect(label).toBe(apiText);
  });
});

describe('[O-5] the status line never promises VAT a person has not approved', () => {
  it('each state in the owner’s words', () => {
    expect(vatStatusLine(view({ status: 'PENDING' }))).toMatch(/A person at Swift checks it before anything changes/);
    expect(vatStatusLine(view({ status: 'APPROVED', effective: false }))).toBe('Approved, but VAT is not on your orders right now. Your prices and receipts show no VAT.');
    expect(vatStatusLine(view({
      status: 'APPROVED', effective: true, approved: { number: '012345678', registeredName: 'Sample Shop Ltd', effectiveFrom: '2026-01-01T00:00:00.000Z', reviewedAt: null },
    }))).toBe('Approved from 1 Jan 2026. Your prices include VAT at 14%, and receipts say “VAT charged by Sample Shop Ltd · VAT reg. no. 012345678”.');
    expect(vatStatusLine(view({
      status: 'APPROVED', effective: true, mode: 'ADD_VAT_AT_CHECKOUT', approved: { number: '012345678', registeredName: 'Sample Shop Ltd', effectiveFrom: '2026-01-01T00:00:00.000Z', reviewedAt: null },
    }))).toBe('Approved from 1 Jan 2026. Swift adds VAT at 14% to the prices you type for standard-rated items, and receipts say “VAT charged by Sample Shop Ltd · VAT reg. no. 012345678”.');
    expect(vatStatusLine(view({ status: 'REJECTED', reviewNote: 'The photo is unreadable' }))).toBe('Not approved: The photo is unreadable. Correct it and send your certificate again.');
    expect(vatStatusLine(view({ status: 'REVOKED', reviewNote: 'GRA cancelled the registration' }))).toBe('VAT withdrawn: GRA cancelled the registration. New orders carry no VAT.');
  });

  it('no state ever calls Swift’s receipt a tax invoice', () => {
    for (const status of ['NONE', 'PENDING', 'APPROVED', 'REJECTED', 'REVOKED'] as const) {
      expect(vatStatusLine(view({ status, effective: status === 'APPROVED' })).toLowerCase()).not.toContain('invoice');
    }
  });
});
