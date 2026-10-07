import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mockApi, renderWithQuery, type ApiRequest, type ApiReply } from '@/test/test-utils';
import { setSelectedStore } from '@/lib/auth';
import {
  DOC_LABELS, currentDocument, documentState, uploadLabel, type PartnerDocument,
} from '@/lib/partner-documents';
import StoreDocumentsPage from '@/app/dashboard/documents/page';
import MoverDocumentsPage from '@/app/portal/documents/page';
import HelpPage from '@/app/(app)/account/help/page';
import { CustomerSessionProvider, type CustomerSession } from '@/components/customer-session';

const signedIn: CustomerSession = { status: 'signed-in', scope: 'partner', epoch: 0, ensureSignedIn: async () => true, nearPoint: null, setNearPoint: () => undefined };

const ordering = vi.hoisted(() => ({ open: true }));
vi.mock('@/lib/use-web-ordering', () => ({ useWebOrderingOpen: () => ordering.open }));
vi.mock('@/site.config', () => ({
  site: { legalEntityName: 'Swift Test Company Ltd', supportEmail: 'support@swiftgy.com' },
  launch: { markets: ['Georgetown, Guyana'], webOrdering: 'soon' },
  showAppStoreBadges: false,
  SITE_ORIGIN: 'https://swiftgy.com',
}));

// ---------------------------------------------------------------------------
// [DOCS-1 · the owner's case] A partner whose document was turned down sees
// the reviewer's reason and sends a new copy of THAT document only — on the
// web as in the app. Nothing about it means starting the application again.
// ---------------------------------------------------------------------------

const DAY = 24 * 60 * 60 * 1000;
const iso = (offsetDays: number) => new Date(Date.now() + offsetDays * DAY).toISOString();
const doc = (over: Partial<PartnerDocument>): PartnerDocument => ({
  id: 'd', docType: 'business_registration', status: 'APPROVED', expiresAt: null, reviewNote: null, createdAt: iso(-10), ...over,
});

describe('[DOCS-1] what each document row says and allows', () => {
  it('speaks for a document the way the app does: one in review, else the live approval, else the newest', () => {
    const rejected = doc({ id: 'r', status: 'REJECTED', createdAt: iso(-1), reviewNote: 'Blurred' });
    const pending = doc({ id: 'p', status: 'PENDING', createdAt: iso(-2) });
    const approved = doc({ id: 'a', status: 'APPROVED', createdAt: iso(-30), expiresAt: iso(200) });
    expect(currentDocument([rejected, pending, approved], 'business_registration')?.id).toBe('p');
    expect(currentDocument([rejected, approved], 'business_registration')?.id).toBe('a');
    expect(currentDocument([rejected], 'business_registration')?.id).toBe('r');
    expect(currentDocument([rejected], 'tin_certificate')).toBeUndefined();
    // Whatever order the list arrives in, the newest submission speaks.
    const olderRejection = doc({ id: 'old', status: 'REJECTED', createdAt: iso(-9), reviewNote: 'Old reason' });
    expect(currentDocument([olderRejection, rejected], 'business_registration')?.id).toBe('r');
  });

  it('offers an upload exactly when the server takes one', () => {
    expect(uploadLabel(documentState(undefined))).toBe('Upload');
    expect(uploadLabel(documentState(doc({ status: 'REJECTED' })))).toBe('Upload a new copy');
    expect(uploadLabel(documentState(doc({ status: 'EXPIRED' })))).toBe('Upload a renewal');
    expect(uploadLabel(documentState(doc({ status: 'APPROVED', expiresAt: iso(-1) })))).toBe('Upload a renewal');
    // The server accepts a renewal from 30 days before expiry, and refuses one earlier.
    expect(uploadLabel(documentState(doc({ status: 'APPROVED', expiresAt: iso(29) })))).toBe('Upload a renewal');
    expect(uploadLabel(documentState(doc({ status: 'APPROVED', expiresAt: iso(31) })))).toBeNull();
    expect(uploadLabel(documentState(doc({ status: 'APPROVED', expiresAt: null })))).toBeNull();
    // Nothing while it is being checked.
    expect(uploadLabel(documentState(doc({ status: 'PENDING' })))).toBeNull();
  });

  it('names every document exactly as the phone app does', () => {
    const source = readFileSync(join(__dirname, '..', '..', '..', 'mobile', 'src', 'components', 'onboarding', 'DocumentUploadCard.tsx'), 'utf8');
    const block = /const DOC_LABELS: Record<string, string> = \{([\s\S]*?)\n\};/.exec(source);
    expect(block, 'the app’s DOC_LABELS').not.toBeNull();
    const app = Object.fromEntries([...block![1]!.matchAll(/^\s*([a-z_]+):\s*(['"])(.*)\2,\s*$/gm)].map((m) => [m[1]!, m[3]!]));
    expect(Object.keys(app).length).toBeGreaterThan(10);
    expect(DOC_LABELS).toEqual(app);
  });
});

const STORE = { id: 'store-1', name: 'Shanta Kitchen', vendorType: 'RESTAURANT', isCurrentlyOpen: false, acceptingOrders: false, city: 'Georgetown', isVerified: false };
const REASON = 'The photo is too blurred to read the registration number.';

function storeStatus() {
  return {
    checklist: ['business_registration', 'tin_certificate', 'food_handler_cert', 'storefront_photo'],
    documents: [
      doc({ id: 'b2', docType: 'business_registration', status: 'REJECTED', reviewNote: REASON, createdAt: iso(-1) }),
      doc({ id: 'b1', docType: 'business_registration', status: 'REJECTED', reviewNote: 'An older reason', createdAt: iso(-5) }),
      doc({ id: 't1', docType: 'tin_certificate', status: 'APPROVED', expiresAt: null }),
      doc({ id: 'f1', docType: 'food_handler_cert', status: 'PENDING' }),
    ],
    missing: ['business_registration', 'food_handler_cert', 'storefront_photo'],
    roleVerified: false,
  };
}

let api: (_request: ApiRequest) => ApiReply | Promise<ApiReply>;
let calls: ReturnType<typeof mockApi>;
const posts = (path: string) => calls.mock.calls
  .filter(([url, init]) => new URL(String(url)).pathname === path && (init as RequestInit | undefined)?.method === 'POST')
  .map(([, init]) => (init as RequestInit).body);

beforeEach(() => {
  ordering.open = true;
  localStorage.clear();
  setSelectedStore('store-1');
  api = ({ url }) => {
    if (url.pathname === '/api/v1/vendor/stores') return { body: { success: true, data: { stores: [STORE], selectedId: 'store-1' } } };
    if (url.pathname === '/api/v1/verification/status') return { body: { success: true, data: storeStatus() } };
    if (url.pathname === '/api/v1/verification/upload') return { body: { success: true, data: { url: 'private/verification/new-copy.jpg' } } };
    if (url.pathname === '/api/v1/verification/documents') return { body: { success: true, data: { id: 'b3', status: 'PENDING' } } };
    return { status: 404, body: { success: false } };
  };
  calls = mockApi((request) => api(request));
});

describe('[DOCS-1] a store owner’s Documents page', () => {
  it('shows each document of the store’s own checklist, the reviewer’s reason on the one turned down, and an upload only where one is accepted', async () => {
    renderWithQuery(<StoreDocumentsPage />);
    const business = await screen.findByRole('listitem', { name: 'Business Registration' });
    const statusRead = calls.mock.calls.map(([url]) => new URL(String(url))).find((url) => url.pathname === '/api/v1/verification/status')!;
    expect(statusRead.searchParams.get('role')).toBe('RESTAURANT');

    expect(within(business).getByText('Turned down')).toBeTruthy();
    expect(within(business).getByText(REASON)).toBeTruthy();
    expect(within(business).queryByText('An older reason')).toBeNull();
    expect(within(business).getByRole('button', { name: 'Upload a new copy: Business Registration' })).toBeTruthy();

    const tin = screen.getByRole('listitem', { name: 'TIN Certificate' });
    expect(within(tin).getByText('Approved')).toBeTruthy();
    expect(within(tin).queryByRole('button')).toBeNull();

    const handler = screen.getByRole('listitem', { name: "Food Handler's Certificate" });
    expect(within(handler).getByText('In review')).toBeTruthy();
    expect(within(handler).queryByRole('button')).toBeNull();

    const photo = screen.getByRole('listitem', { name: 'Storefront Photo' });
    expect(within(photo).getByRole('button', { name: 'Upload: Storefront Photo' })).toBeTruthy();
    expect(screen.getByRole('status').textContent).toMatch(/3 documents still to be approved/);
  });

  it('sends a new copy of THAT document only, after consent, and the page re-reads where it stands', async () => {
    const view = renderWithQuery(<StoreDocumentsPage />);
    const business = await screen.findByRole('listitem', { name: 'Business Registration' });
    await view.user.click(within(business).getByRole('button', { name: /Upload a new copy/ }));
    const choose = within(business).getByRole('button', { name: /Choose file/ });
    expect((choose as HTMLButtonElement).disabled).toBe(true);
    await view.user.click(within(business).getByRole('checkbox'));
    expect((choose as HTMLButtonElement).disabled).toBe(false);
    const statusReads = () => calls.mock.calls.filter(([url]) => new URL(String(url)).pathname === '/api/v1/verification/status').length;
    const before = statusReads();
    fireEvent.change(within(business).getByLabelText('File for Business Registration'), { target: { files: [new File(['jpg'], 'copy.jpg', { type: 'image/jpeg' })] } });

    expect(await within(business).findByText('Sent. It is in review now.')).toBeTruthy();
    expect(posts('/api/v1/verification/upload')).toHaveLength(1);
    const filed = posts('/api/v1/verification/documents').map((body) => JSON.parse(String(body)));
    expect(filed).toEqual([{ role: 'RESTAURANT', docType: 'business_registration', fileUrl: 'private/verification/new-copy.jpg', consent: true, privacyNoticeVersion: 'web-v1' }]);
    await waitFor(() => expect(statusReads()).toBeGreaterThan(before));
  });

  it('“Think this is wrong?” opens Help on that document, and never carries the reviewer’s words in the link', async () => {
    renderWithQuery(<StoreDocumentsPage />);
    const business = await screen.findByRole('listitem', { name: 'Business Registration' });
    const href = within(business).getByRole('link', { name: /Think this is wrong/ }).getAttribute('href')!;
    expect(href).toBe('/account/help?topic=VENDOR&document=business_registration');
    expect(decodeURIComponent(href)).not.toContain('blurred');
  });

  it('before web ordering opens on the public site (account pages show “Launching soon”), the same link emails support about that document instead', async () => {
    ordering.open = false;
    renderWithQuery(<StoreDocumentsPage />);
    const business = await screen.findByRole('listitem', { name: 'Business Registration' });
    const href = within(business).getByRole('link', { name: /Think this is wrong/ }).getAttribute('href')!;
    expect(href).toBe(`mailto:support@swiftgy.com?subject=${encodeURIComponent('About my Business Registration review')}`);
    expect(decodeURIComponent(href)).not.toContain('blurred');
  });

  it('a checklist that fails to load says so and offers to try again — never an empty list', async () => {
    api = ((base) => (request: ApiRequest) => (request.url.pathname === '/api/v1/verification/status' ? { status: 503, body: { success: false, error: { message: 'busy' } } } : base(request)))(api);
    renderWithQuery(<StoreDocumentsPage />);
    expect(await screen.findByText(/Couldn.t load your document checklist/, {}, { timeout: 4000 })).toBeTruthy();
    expect(screen.queryByRole('listitem')).toBeNull();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
  });
});

describe('[DOCS-1] a mover’s Documents page', () => {
  beforeEach(() => {
    api = ({ url }) => {
      if (url.pathname === '/api/v1/rider/profile') return { body: { success: true, data: { vehicleType: 'MOTORCYCLE' } } };
      if (url.pathname === '/api/v1/driver/profile') return { status: 404, body: { success: false } };
      if (url.pathname === '/api/v1/verification/status') {
        return { body: { success: true, data: {
          checklist: ['drivers_licence', 'vehicle_insurance', 'national_id', 'police_clearance'],
          documents: [
            doc({ id: 'l1', docType: 'drivers_licence', status: 'REJECTED', reviewNote: 'Expired licence uploaded.' }),
            doc({ id: 'i1', docType: 'vehicle_insurance', status: 'APPROVED', expiresAt: iso(12) }),
            doc({ id: 'n1', docType: 'national_id', status: 'APPROVED', expiresAt: iso(400) }),
            doc({ id: 'p1', docType: 'police_clearance', status: 'PENDING' }),
          ],
          missing: ['drivers_licence', 'police_clearance'], roleVerified: false,
        } } };
      }
      return { status: 404, body: { success: false } };
    };
  });

  it('a turned-down document says why and offers a new copy (not a “renewal”); in review and long-valid documents offer nothing; one near expiry offers a renewal', async () => {
    renderWithQuery(<MoverDocumentsPage />);
    const licence = await screen.findByRole('listitem', { name: "Driver's Licence" });
    expect(within(licence).getByText('Expired licence uploaded.')).toBeTruthy();
    expect(within(licence).getByRole('button', { name: "Upload a new copy: Driver's Licence" })).toBeTruthy();
    expect(within(licence).getByRole('link', { name: /Think this is wrong/ }).getAttribute('href')).toBe('/account/help?topic=MOVER&document=drivers_licence');
    expect(within(screen.getByRole('listitem', { name: 'Vehicle Insurance' })).getByRole('button', { name: /Upload a renewal/ })).toBeTruthy();
    expect(within(screen.getByRole('listitem', { name: 'National ID' })).queryByRole('button')).toBeNull();
    expect(within(screen.getByRole('listitem', { name: 'Police Clearance Certificate' })).queryByRole('button')).toBeNull();
    const statusRead = calls.mock.calls.map(([url]) => new URL(String(url))).find((url) => url.pathname === '/api/v1/verification/status')!;
    expect([statusRead.searchParams.get('role'), statusRead.searchParams.get('vehicleType')]).toEqual(['MOVER', 'MOTORCYCLE']);
  });
});

describe('[DOCS-1] Help opened about a document review', () => {
  it('starts on the partner’s topic with the document named in the summary', async () => {
    api = ({ url }) => (url.pathname === '/api/v1/customer/support' ? { body: { success: true, data: [] } } : { status: 404, body: { success: false } });
    renderWithQuery(<CustomerSessionProvider value={signedIn}>{await HelpPage({ searchParams: Promise.resolve({ topic: 'VENDOR', document: 'business_registration' }) })}</CustomerSessionProvider>);
    expect((await screen.findByRole('combobox', { name: 'Topic' }) as HTMLSelectElement).value).toBe('VENDOR');
    expect((screen.getByRole('textbox', { name: 'Short summary' }) as HTMLInputElement).value).toBe('About my Business Registration review');
  });

  it('ignores a topic or document it does not know', async () => {
    api = ({ url }) => (url.pathname === '/api/v1/customer/support' ? { body: { success: true, data: [] } } : { status: 404, body: { success: false } });
    renderWithQuery(<CustomerSessionProvider value={signedIn}>{await HelpPage({ searchParams: Promise.resolve({ topic: 'ADMIN', document: '<script>' }) })}</CustomerSessionProvider>);
    expect((await screen.findByRole('combobox', { name: 'Topic' }) as HTMLSelectElement).value).toBe('OTHER');
    expect((screen.getByRole('textbox', { name: 'Short summary' }) as HTMLInputElement).value).toBe('');
  });
});
