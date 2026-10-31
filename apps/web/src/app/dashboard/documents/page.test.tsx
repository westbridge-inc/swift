import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockApi, renderWithQuery, type ApiRequest } from '@/test/test-utils';
import DocumentsPage from './page';

// ---------------------------------------------------------------------------
// [OPEN-EARLY PR-2 · owner 31 Oct 2026] A store's Documents page on the website, the phone's store checklist: partners
// sign up on swiftgy.com before the apps are out and must send every onboarding document here. The whole page runs on
// the real API client over a stubbed network: the checklist per store type, one consent tick, the upload then the
// filing with exactly the phone's body, the server's refusal shown as it is, the owner-only rule, an approved current
// document locked, a waiting copy replaced only after asking, the own-name declaration. Synthetic stores and files only.
// ---------------------------------------------------------------------------

type Doc = { id: string; docType: string; status: string; expiresAt: string | null; reviewNote: string | null; createdAt: string; replaced?: boolean };
const writes: Array<{ method: string; path: string; store: string | undefined; body: unknown }> = [];
const reads: string[] = [];

const STORES: Record<string, { name: string; vendorType: string }> = {
  shop: { name: 'Sample Corner Shop', vendorType: 'STORE' },
  kitchen: { name: 'Sample Kitchen', vendorType: 'RESTAURANT' },
  salon: { name: 'Sample Salon', vendorType: 'SERVICE' },
  grocer: { name: 'Persaud', vendorType: 'SUPERMARKET' },
};

interface Setup {
  role?: string;
  store?: keyof typeof STORES;
  checklist?: string[];
  optional?: string[];
  documents?: Doc[];
  consentOnRecord?: boolean;
  refuse?: { code: string; message: string; status?: number };
  statusFails?: boolean;
  food?: boolean;
}

function api(s: Setup = {}) {
  const storeId = s.store ?? 'shop';
  const store = STORES[storeId]!;
  return mockApi(({ method, url, init }: ApiRequest) => {
    const path = url.pathname.replace('/api/v1', '');
    const header = (init?.headers as Record<string, string> | undefined)?.['x-vendor-id'];
    if (method !== 'GET') {
      const body = init?.body instanceof FormData ? { file: (init.body.get('file') as File | null)?.name ?? null } : init?.body ? JSON.parse(String(init.body)) : null;
      writes.push({ method, path, store: header, body });
      if (path === '/verification/upload') return { body: { success: true, data: { url: 'verification/user-1/synthetic.enc' } } };
      if (s.refuse && path === '/verification/documents') {
        return { status: s.refuse.status ?? 409, body: { success: false, error: { code: s.refuse.code, message: s.refuse.message } } };
      }
      return { status: 201, body: { success: true, data: {} } };
    }
    reads.push(`${path}${url.search}`);
    if (path === '/vendor/stores') {
      return { body: { success: true, data: { stores: [{ id: storeId, ...store, isCurrentlyOpen: false, acceptingOrders: false, city: 'Georgetown', isVerified: false }], selectedId: storeId, myRole: s.role ?? 'OWNER' } } };
    }
    if (path === '/verification/status') {
      if (s.statusFails) return { status: 500, body: { success: false, error: { code: 'INTERNAL', message: 'Something went wrong.' } } };
      return { body: { success: true, data: {
        checklist: s.checklist ?? ['owner_national_id', 'business_registration', 'tin_certificate', 'storefront_photo'],
        optional: s.optional ?? [],
        documents: s.documents ?? [],
        missing: [],
        roleVerified: false,
        documentConsent: { tick: 'document_v1', given: s.consentOnRecord === true, givenAt: s.consentOnRecord ? '2026-10-20T14:00:00.000Z' : null },
        ...(s.food ? { foodHandlerAttestation: { version: 'v1', tick: 'Everyone who handles food here holds a current food handler’s certificate.', stores: [{ vendorId: storeId, name: store.name, attested: false }] } } : {}),
      } } };
    }
    if (path === '/vendor/vat') return { body: { success: true, data: { available: false, status: 'NONE', certificate: null } } };
    if (path === '/vendor/onboarding/weekly-fee') return { body: { success: true, data: { vendorId: storeId, required: false, ticked: false } } };
    return { status: 404, body: { success: false } };
  });
}

beforeEach(async () => {
  writes.length = 0;
  reads.length = 0;
  (await import('@/lib/auth')).setSelectedStore('shop');
});
afterEach(() => { vi.unstubAllGlobals(); localStorage.clear(); });

const card = (name: string) => screen.getByText(name).closest('button') as HTMLButtonElement;
const tick = () => screen.getByRole('checkbox', { name: /I consent to Swift processing this document for verification/ });
const pick = (name: string, file = new File(['synthetic'], 'synthetic-document.pdf', { type: 'application/pdf' })) => {
  fireEvent.change(screen.getByLabelText(`Choose a file for ${name}`), { target: { files: [file] } });
};

describe('[OPEN-EARLY PR-2] the store’s documents on the website', () => {
  it('a shop: the phone’s required steps by their plain names, one tick, the progress and where each stands', async () => {
    api();
    renderWithQuery(<DocumentsPage />);
    expect(await screen.findByRole('heading', { name: 'Required steps' })).toBeTruthy();
    for (const name of ['Owner National ID or Digital ID card', 'Business Registration', 'TIN Certificate', 'Storefront Photo']) expect(screen.getByText(name)).toBeTruthy();
    expect(screen.getByText('0 of 4 approved')).toBeTruthy();
    expect(reads).toContain('/verification/status?role=STORE');
    // Nothing opens before the tick (the phone's words), then every card opens.
    expect(card('Business Registration').disabled).toBe(true);
    expect(screen.getAllByText('Tick the box above to upload')).toHaveLength(4);
    fireEvent.click(tick());
    expect(card('Business Registration').disabled).toBe(false);
    expect(screen.getByText('Recommended next step')).toBeTruthy();
    // [ROLE-DOCS] no business registration yet: the own-name route is offered
    expect(screen.getByText('No business name? Trade under your own name')).toBeTruthy();
  });

  it('uploads the file, then files it for the store type with exactly the phone’s body (ticked on this visit)', async () => {
    api();
    renderWithQuery(<DocumentsPage />);
    await screen.findByText('Business Registration');
    fireEvent.click(tick());
    pick('Business Registration');
    await waitFor(() => expect(writes).toHaveLength(2));
    expect(writes).toEqual([
      { method: 'POST', path: '/verification/upload', store: 'shop', body: { file: 'synthetic-document.pdf' } },
      { method: 'POST', path: '/verification/documents', store: 'shop', body: {
        role: 'STORE', docType: 'business_registration', fileUrl: 'verification/user-1/synthetic.enc', consent: true,
        privacyNoticeVersion: 'web-v1', consentTick: 'document_v1', consentVia: 'checkbox',
      } },
    ]);
  });

  it('a tick the person gave before stands from the record, says when, and files with consentVia "record"', async () => {
    api({ consentOnRecord: true });
    renderWithQuery(<DocumentsPage />);
    await screen.findByText('Storefront Photo');
    expect((tick() as HTMLInputElement).checked).toBe(true);
    expect(screen.getByText('You ticked this on 20 Oct 2026.')).toBeTruthy();
    pick('Storefront Photo', new File(['synthetic'], 'synthetic-photo.jpg', { type: 'image/jpeg' }));
    await waitFor(() => expect(writes).toHaveLength(2));
    expect(writes[1]!.body).toMatchObject({ docType: 'storefront_photo', consentVia: 'record', consentTick: 'document_v1' });
    // Unticking stops the next upload.
    fireEvent.click(tick());
    expect(card('TIN Certificate').disabled).toBe(true);
  });

  it.each([
    ['DOC_TYPE_NOT_ACCEPTED', 'That document is not on this store’s list.'],
    ['ALREADY_APPROVED', 'This document is already approved and current.'],
    ['FOOD_HANDLERS_TICK_ONLY', 'Confirm your food handlers with the tick instead of uploading.'],
  ])('a refusal (%s) is shown in the server’s own words on the card', async (code, message) => {
    api({ refuse: { code, message } });
    renderWithQuery(<DocumentsPage />);
    await screen.findByText('TIN Certificate');
    fireEvent.click(tick());
    pick('TIN Certificate');
    expect(await screen.findByText(message)).toBeTruthy();
  });

  it('a manager or staff login sees whose the documents are, and nothing is read or offered', async () => {
    for (const role of ['MANAGER', 'STAFF']) {
      reads.length = 0;
      api({ role });
      const { unmount } = renderWithQuery(<DocumentsPage />);
      expect(await screen.findByText(/only the owner can see and upload them/)).toBeTruthy();
      expect(screen.queryByRole('checkbox')).toBeNull();
      expect(screen.queryByText('Required steps')).toBeNull();
      expect(reads.some((r) => r.startsWith('/verification/status'))).toBe(false);
      unmount();
    }
  });

  it('an approved, current document is locked; one inside its renewal window opens again; a waiting copy asks before it is replaced', async () => {
    const day = 86_400_000;
    api({ consentOnRecord: true, documents: [
      { id: 'd1', docType: 'owner_national_id', status: 'APPROVED', expiresAt: '2030-06-01T00:00:00.000Z', reviewNote: null, createdAt: '2026-10-01T00:00:00.000Z' },
      { id: 'd2', docType: 'business_registration', status: 'APPROVED', expiresAt: new Date(Date.now() + 10 * day - 3_600_000).toISOString(), reviewNote: null, createdAt: '2026-10-01T00:00:00.000Z' },
      { id: 'd3', docType: 'tin_certificate', status: 'PENDING', expiresAt: null, reviewNote: null, createdAt: '2026-10-29T15:00:00.000Z', replaced: true },
      { id: 'd4', docType: 'storefront_photo', status: 'REJECTED', expiresAt: null, reviewNote: 'The sign is not readable', createdAt: '2026-10-28T15:00:00.000Z' },
    ] });
    renderWithQuery(<DocumentsPage />);
    await screen.findByText('Owner National ID or Digital ID card');
    expect(card('Owner National ID or Digital ID card').disabled).toBe(true);
    expect(screen.getByText('Approved — valid until 1 Jun 2030')).toBeTruthy();
    expect(card('Business Registration').disabled).toBe(false);
    expect(screen.getByText('Expires in 10 days — tap to upload the renewal')).toBeTruthy();
    expect(screen.getByText('Expiring soon')).toBeTruthy();
    expect(screen.getByText('Rejected: The sign is not readable — tap to re-upload')).toBeTruthy();
    expect(screen.getByText('Replaced — waiting for review · tap to replace again')).toBeTruthy();
    expect(screen.getByText('2 of 4 approved')).toBeTruthy();
    // Replacing a waiting copy: asked first, in the phone's words; Cancel sends nothing.
    fireEvent.click(card('TIN Certificate'));
    const ask = screen.getByRole('alertdialog', { name: 'Replace this document?' });
    expect(within(ask).getByText(/Your new upload replaces the one waiting for review/)).toBeTruthy();
    fireEvent.click(within(ask).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(writes).toEqual([]);
  });

  it('a restaurant: the food handlers step is the tick, never an upload', async () => {
    (await import('@/lib/auth')).setSelectedStore('kitchen');
    api({ store: 'kitchen', checklist: ['owner_national_id', 'business_registration', 'food_handler_attestation'], optional: ['food_handler_cert'], food: true });
    renderWithQuery(<DocumentsPage />);
    expect(await screen.findByText('Your food handlers')).toBeTruthy();
    expect(screen.queryByText('Food handlers confirmation')).toBeNull();
    expect(screen.queryByLabelText('Choose a file for Food handlers confirmation')).toBeNull();
    expect(reads).toContain('/verification/status?role=RESTAURANT');
    // The optional certificate is offered, marked optional, never counted.
    expect(screen.getByRole('heading', { name: 'Optional' })).toBeTruthy();
    expect(screen.getByText("Food Handler's Certificate")).toBeTruthy();
    expect(screen.getByText('Optional. Not needed to start working.')).toBeTruthy();
    expect(screen.getByText('0 of 3 approved')).toBeTruthy();
  });

  it('a Services business: its own list, no own-name offer; a police clearance is named, sent in the app', async () => {
    (await import('@/lib/auth')).setSelectedStore('salon');
    api({ store: 'salon', checklist: ['owner_national_id', 'police_clearance'] });
    renderWithQuery(<DocumentsPage />);
    await screen.findByText('Owner National ID or Digital ID card');
    expect(reads).toContain('/verification/status?role=SERVICE');
    expect(screen.getByText('Police Clearance Certificate')).toBeTruthy();
    expect(screen.getByText(/Added in the Swift app, where it has its own consent/)).toBeTruthy();
    expect(screen.queryByLabelText('Choose a file for Police Clearance Certificate')).toBeNull();
    expect(screen.queryByText(/Trade under your own name/)).toBeNull();
  });

  it('own name: the declaration is signed here for the selected store, and the store can go back to a registered name', async () => {
    (await import('@/lib/auth')).setSelectedStore('grocer');
    api({ store: 'grocer', checklist: ['owner_national_id', 'own_name_declaration'] });
    renderWithQuery(<DocumentsPage />);
    expect(await screen.findByText('Sign: I trade under my own name')).toBeTruthy();
    expect(screen.getByText('You sign this for “Persaud” only.')).toBeTruthy();
    const sign = screen.getByRole('button', { name: 'Sign the declaration' }) as HTMLButtonElement;
    expect(sign.disabled).toBe(true);
    fireEvent.click(screen.getByRole('checkbox', { name: 'I have read the declaration above and I sign it.' }));
    fireEvent.click(sign);
    await waitFor(() => expect(writes).toContainEqual({ method: 'POST', path: '/vendor/onboarding/own-name', store: 'grocer', body: { accept: true, attestationVersion: 'v1' } }));
    fireEvent.click(screen.getByRole('button', { name: 'I use a registered business name instead' }));
    await waitFor(() => expect(writes).toContainEqual({ method: 'DELETE', path: '/vendor/onboarding/own-name', store: 'grocer', body: null }));
  });

  it('a failed read says so with Try again, never an empty list', async () => {
    api({ statusFails: true });
    renderWithQuery(<DocumentsPage />);
    expect(await screen.findByText(/your verification steps/i)).toBeTruthy();
    expect(screen.queryByText('Required steps')).toBeNull();
    expect(screen.getByRole('button', { name: /try again/i })).toBeTruthy();
  });
});
