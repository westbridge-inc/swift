import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import StoreQrPage from './page';
import { mockApi, renderWithQuery, type ApiRequest } from '@/test/test-utils';

// ---------------------------------------------------------------------------
// [STORE-LINK+NAMES · owner 30 Oct 21:47Z] Stores share their Swift link with
// customers who message them (WhatsApp and the like). The phone app's
// "My QR & number" screen (apps/mobile/src/modules/vendor/screens/
// VendorMyQrScreen.tsx) has the live code, the short link to copy, Share link
// and Open web menu; the web business dashboard gets the SAME: the same server
// reads (GET /vendor/qr, then the public resolver confirms THIS store before
// anything can be shared), the same URL and the same words.
// ---------------------------------------------------------------------------

type Role = 'OWNER' | 'MANAGER' | 'STAFF';
const SHORT = 'https://swiftgy.test/s/abcdfghjkm';
/** [REVIEW-F #2262 S4-1] The copy button's accessible name carries the link it shows. */
const COPY_NAME = `Copy web store link ${SHORT}`;
const CANONICAL = 'https://swiftgy.test/store/sample-kitchen-x1';
const reads: string[] = [];

function qrApi(opts: { role?: Role; verdict?: string; publicVendorId?: string | null; publicFails?: boolean; qrFails?: boolean } = {}) {
  const { role = 'OWNER', verdict = 'WEB_RENDER', publicVendorId = 'store-1' } = opts;
  return mockApi((request: ApiRequest) => {
    const path = request.url.pathname.replace('/api/v1', '');
    reads.push(path);
    if (path === '/vendor/stores') {
      return { body: { success: true, data: { stores: [{ id: 'store-1', name: 'Sample Kitchen', vendorType: 'RESTAURANT', isCurrentlyOpen: true, acceptingOrders: true, city: null, isVerified: true }], selectedId: 'store-1', myRole: role } } };
    }
    if (path === '/vendor/qr') {
      if (opts.qrFails) return { status: 503, body: { success: false, error: { message: 'Service unavailable' } } };
      return { body: { success: true, data: {
        deepLink: SHORT, shortUrl: SHORT, shortCode: 'ABCDFGHJKM', canonicalUrl: CANONICAL, version: 2, status: 'ACTIVE', graceDays: 30,
        svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>', vendorName: 'Sample Kitchen',
      } } };
    }
    if (path === '/public/qr/ABCDFGHJKM') {
      if (opts.publicFails) return { status: 503, body: { success: false, error: { message: 'Service unavailable' } } };
      return { body: { success: true, data: { verdict, vendorId: verdict === 'WEB_RENDER' ? publicVendorId : null, slug: null } } };
    }
    return { status: 404, body: { success: false } };
  });
}

const clipboard = { writeText: vi.fn(async (_text: string) => undefined) };
/** user-event puts its own clipboard on the page when a test starts: ours goes on after it. */
const ownClipboard = () => Object.defineProperty(navigator, 'clipboard', { value: clipboard, configurable: true });
const share = vi.fn(async (_data: ShareData) => undefined);

beforeEach(async () => {
  reads.length = 0;
  clipboard.writeText.mockReset().mockResolvedValue(undefined);
  share.mockReset().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'share', { value: share, configurable: true, writable: true });
  (await import('@/lib/auth')).setSelectedStore('store-1');
});
afterEach(() => {
  Reflect.deleteProperty(navigator, 'share');
});

describe('[STORE-LINK] the web dashboard shares the store link like the phone app', () => {
  it('shows the live code, the store, the short link and the phone\'s words once Swift confirms this store', async () => {
    qrApi();
    renderWithQuery(<StoreQrPage />);
    expect(await screen.findByRole('heading', { level: 1, name: 'My QR & number' })).toBeTruthy();
    expect(await screen.findByText('Customers scan this to open your live web menu — no app install')).toBeTruthy();
    const code = screen.getByRole('img', { name: 'QR code for Sample Kitchen' });
    // The server's code is drawn as an image, never written into the page as markup.
    expect(code.getAttribute('src')).toMatch(/^data:image\/svg\+xml,/);
    expect(document.querySelector('svg[viewBox="0 0 10 10"]')).toBeNull();
    expect(screen.getByText('Sample Kitchen')).toBeTruthy();
    expect(screen.getByText('v2')).toBeTruthy();
    // [REVIEW-F #2262 S4-1 · WCAG 2.5.3 label in name] The button's name says what it does AND the link it shows.
    const copy = screen.getByRole('button', { name: COPY_NAME });
    expect(copy.textContent).toContain(SHORT);
    expect(copy.getAttribute('aria-label')).toBe(`Copy web store link ${SHORT}`);
    const open = screen.getByRole('link', { name: 'Open web menu' });
    expect(open.getAttribute('href')).toBe(CANONICAL);
    expect(open.getAttribute('target')).toBe('_blank');
    for (const step of ['Customer scans', 'Your store opens', 'They order']) expect(screen.getByText(step)).toBeTruthy();
    expect(screen.getByText('Where to place your QR')).toBeTruthy();
    expect(screen.getByText('On your WhatsApp status each week')).toBeTruthy();
    expect(reads).toContain('/public/qr/ABCDFGHJKM');
  });

  it('copies the short link (the URL the phone copies) and says so', async () => {
    qrApi();
    const view = renderWithQuery(<StoreQrPage />);
    ownClipboard();
    await screen.findByText('Customers scan this to open your live web menu — no app install');
    await view.user.click(screen.getByRole('button', { name: COPY_NAME }));
    expect(clipboard.writeText).toHaveBeenCalledWith(SHORT);
    expect(await screen.findByText('Store link copied.')).toBeTruthy();
  });

  it('a copy the browser refuses says so, never "copied"', async () => {
    qrApi();
    clipboard.writeText.mockRejectedValue(new Error('denied'));
    const view = renderWithQuery(<StoreQrPage />);
    ownClipboard();
    await screen.findByText('Customers scan this to open your live web menu — no app install');
    await view.user.click(screen.getByRole('button', { name: COPY_NAME }));
    expect(await screen.findByText("Couldn't copy the link. Use Share link instead.")).toBeTruthy();
    expect(screen.queryByText('Store link copied.')).toBeNull();
  });

  it('[REVIEW-F #2262 S4-2] a refused copy on a browser with no share sheet names the button it shows: Share on WhatsApp', async () => {
    Reflect.deleteProperty(navigator, 'share');
    qrApi();
    clipboard.writeText.mockRejectedValue(new Error('denied'));
    const view = renderWithQuery(<StoreQrPage />);
    ownClipboard();
    await screen.findByText('Customers scan this to open your live web menu — no app install');
    await view.user.click(screen.getByRole('button', { name: COPY_NAME }));
    expect(await screen.findByText("Couldn't copy the link. Use Share on WhatsApp instead.")).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Share on WhatsApp' })).toBeTruthy();
    expect(screen.queryByText(/Use Share link instead/)).toBeNull();
  });

  it('Share link opens the device\'s share sheet with the phone\'s message', async () => {
    qrApi();
    const view = renderWithQuery(<StoreQrPage />);
    await screen.findByText('Customers scan this to open your live web menu — no app install');
    await view.user.click(screen.getByRole('button', { name: 'Share link' }));
    expect(share).toHaveBeenCalledWith({ text: `Order from Sample Kitchen on Swift: ${SHORT}` });
  });

  it('a browser with no share sheet offers WhatsApp with the same message', async () => {
    Reflect.deleteProperty(navigator, 'share');
    qrApi();
    renderWithQuery(<StoreQrPage />);
    await screen.findByText('Customers scan this to open your live web menu — no app install');
    const whatsapp = await screen.findByRole('link', { name: 'Share on WhatsApp' });
    expect(whatsapp.getAttribute('href')).toBe(`https://wa.me/?text=${encodeURIComponent(`Order from Sample Kitchen on Swift: ${SHORT}`)}`);
    expect(whatsapp.getAttribute('target')).toBe('_blank');
    expect(whatsapp.getAttribute('rel')).toContain('noopener');
    expect(screen.queryByRole('button', { name: 'Share link' })).toBeNull();
  });

  it('a code that does not open a live store: nothing can be shared, copied or opened, and the phone\'s words say why', async () => {
    qrApi({ verdict: 'UNAVAILABLE_PAGE' });
    const view = renderWithQuery(<StoreQrPage />);
    expect(await screen.findByText('This code is not taking customers to a live store yet.')).toBeTruthy();
    expect(screen.getByText('Store link not ready')).toBeTruthy();
    expect(screen.getByText('Swift only enables sharing after the public resolver confirms this exact store. Check your store approval and availability, then retry.')).toBeTruthy();
    expect((screen.getByRole('button', { name: COPY_NAME }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Share link' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByRole('link', { name: 'Open web menu' })).toBeNull();
    expect((screen.getByRole('button', { name: 'Open web menu' }) as HTMLButtonElement).disabled).toBe(true);
    const before = reads.filter((p) => p.startsWith('/public/qr/')).length;
    await view.user.click(screen.getByRole('button', { name: 'Check again' }));
    await waitFor(() => expect(reads.filter((p) => p.startsWith('/public/qr/')).length).toBeGreaterThan(before));
    expect(clipboard.writeText).not.toHaveBeenCalled();
  });

  it('the resolver names ANOTHER store: treated as not live (never share a link that opens someone else)', async () => {
    qrApi({ publicVendorId: 'store-9' });
    renderWithQuery(<StoreQrPage />);
    expect(await screen.findByText('This code is not taking customers to a live store yet.')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Share link' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('the public check failed: says Swift could not confirm it, and shares nothing', async () => {
    qrApi({ publicFails: true });
    renderWithQuery(<StoreQrPage />);
    expect(await screen.findByText("Swift couldn't confirm that this store link is live.")).toBeTruthy();
    expect((screen.getByRole('button', { name: COPY_NAME }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('the code could not be loaded: the phone\'s error words and a retry, never an empty page', async () => {
    qrApi({ qrFails: true });
    renderWithQuery(<StoreQrPage />);
    expect(await screen.findByText("We couldn't load this store's QR code. Check your connection and try again.")).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Copy web store link/ })).toBeNull();
  });

  it('a staff login is told who shares the link, and the code is never read', async () => {
    qrApi({ role: 'STAFF' });
    renderWithQuery(<StoreQrPage />);
    expect(await screen.findByText('The store link is shared by the store’s owner and managers.')).toBeTruthy();
    expect(reads).not.toContain('/vendor/qr');
  });

  it('carries the phone\'s call-in number card', async () => {
    qrApi();
    renderWithQuery(<StoreQrPage />);
    const card = (await screen.findByText('Your Swift call-in number')).closest('section') as HTMLElement;
    expect(within(card).getByText('Not assigned')).toBeTruthy();
    expect(within(card).getByText('Swift does not yet issue a call-in order number for this store. Online orders still land in Orders with every other live order.')).toBeTruthy();
  });
});
