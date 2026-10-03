import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import type { StorefrontDetail } from './api';
const route = vi.hoisted(() => ({ pathname: '/selfie', router: { replace: vi.fn(), push: vi.fn() } }));
vi.mock('next/navigation', () => ({ usePathname: () => route.pathname, useRouter: () => route.router,
  useSearchParams: () => new URLSearchParams('next=%2Fstore%2Ftest%3Fitem%3Dmeal') }));
const response = (data: unknown) => new Response(JSON.stringify({ success: true, data }));
const deferred = <T,>() => { let resolve!: (_value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; };
async function browser(pathname: string) {
  vi.resetModules(); route.pathname = pathname; route.router.replace.mockClear();
  vi.stubGlobal('BroadcastChannel', class { postMessage() {} });
  let identity = 'a';
  const fetcher = vi.fn(async (input: RequestInfo | URL) => {
    const path = String(input);
    if (path.endsWith('/auth/me')) return response({ user: { id: identity } });
    if (path.endsWith('/auth/verify-otp')) return response({ isNewUser: true });
    if (path.endsWith('/auth/register')) return response({ user: { id: identity, roles: ['VENDOR'] } });
    return response({});
  });
  vi.stubGlobal('fetch', fetcher);
  const auth = await import('./auth'); auth.adoptSession('a');
  return { auth, fetcher, switchTo: (value: string) => { identity = value; } };
}
const store: StorefrontDetail = {
  id: 'test', slug: 'test', name: 'Public test store', description: null, vendorType: 'RESTAURANT',
  logoUrl: null, coverImageUrl: null, city: 'Test city', region: 'Test region', cuisineTypes: [], tags: [],
  displayRating: null, ratingBucket: 'NEW', ratingCount: 0, topRated: false, isCurrentlyOpen: true,
  acceptingOrders: true, estimatedPrepTime: 10, minOrderAmount: 0, isFeatured: false,
  addressLine1: 'Public store address', operatingHours: [], categories: [{ id: 'food', name: 'Food', items: [{
    id: 'meal', name: 'Public meal', description: null, basePrice: 500, imageUrl: null,
    unit: null, isPopular: false, fulfillment: 'DELIVERY',
  }] }],
};
it('AX356 F2 remounts real storefront addresses and cart on a delivered account change', async () => {
  const { auth, fetcher } = await browser('/store/test');
  const { StorefrontExperience } = await import('@/components/storefront/storefront-experience');
  let identity = 'a';
  fetcher.mockImplementation(async (input) => {
    const path = String(input);
    if (path.endsWith('/auth/me')) return response({ user: { id: identity } });
    if (path.endsWith('/addresses')) return response([{ id: identity, label: 'Home', addressLine1: `Private street ${identity}`, city: 'Test city' }]);
    if (path.endsWith('/cart')) return response({ items: [{ id: identity, itemId: 'meal', name: `Private cart ${identity}`, quantity: 1, customerPrice: 500, fulfillment: 'DELIVERY' }], vendor: { id: 'test', name: store.name } });
    return response(store);
  });
  render(<StorefrontExperience store={store} returnPath="/store/test?item=meal" />);
  await screen.findByRole('option', { name: /Private street a/ });
  expect(screen.getAllByText(/Private cart a/).length).toBeGreaterThan(0);
  identity = 'b'; act(() => auth.adoptSession('b'));
  expect(screen.queryByRole('option', { name: /Private street a/ })).toBeNull();
  expect(screen.queryByText(/Private cart a/)).toBeNull();
  await screen.findByRole('option', { name: /Private street b/ });
});
async function camera() {
  const stop = vi.fn();
  const stream = { getTracks: () => [{ stop }] } as unknown as MediaStream;
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: vi.fn().mockResolvedValue(stream) } });
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
  vi.spyOn(HTMLMediaElement.prototype, 'srcObject', 'set').mockImplementation(() => undefined);
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:test-photo-a');
  const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ translate() {}, scale() {}, drawImage() {} } as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((callback) => callback(new Blob(['test-photo'], { type: 'image/jpeg' })));
  const { default: Selfie } = await import('@/app/selfie/page'); render(<Selfie />);
  fireEvent.click(screen.getByRole('button', { name: 'Turn on front camera' }));
  await screen.findByRole('button', { name: 'Take photo now' });
  const video = screen.getByLabelText('Front camera preview');
  Object.defineProperties(video, { videoWidth: { value: 640 }, videoHeight: { value: 480 } });
  return { stop, revoke };
}
async function takePhoto() {
  fireEvent.click(screen.getByRole('button', { name: 'Take photo now' }));
  await screen.findByAltText('Captured profile photo preview');
}
it('AX356 F3 clears a captured photo and revokes its preview on an epoch change', async () => {
  const { auth, fetcher, switchTo } = await browser('/selfie'); const { revoke } = await camera(); await takePhoto();
  switchTo('b'); act(() => auth.adoptSession('b'));
  expect(screen.queryByAltText('Captured profile photo preview')).toBeNull();
  expect(revoke).toHaveBeenCalledWith('blob:test-photo-a');
  fireEvent.click(screen.getByRole('button', { name: 'Save captured photo and continue' }));
  expect(fetcher.mock.calls.some(([url]) => String(url).endsWith('/auth/selfie'))).toBe(false);
});
it('AX356 F3 stops camera tracks and rejects a late capture after an epoch change', async () => {
  const { auth, switchTo } = await browser('/selfie'); const { stop } = await camera();
  let finish!: BlobCallback;
  vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((callback) => { finish = callback; });
  fireEvent.click(screen.getByRole('button', { name: 'Take photo now' }));
  switchTo('b'); act(() => auth.adoptSession('b'));
  expect(stop).toHaveBeenCalled();
  await act(async () => finish(new Blob(['old-photo'])));
  expect(screen.queryByAltText('Captured profile photo preview')).toBeNull();
  expect((screen.getByRole('button', { name: 'Save captured photo and continue' }) as HTMLButtonElement).disabled).toBe(true);
});
it('AX356 F3 stops a camera stream that arrives after the epoch changes', async () => {
  const { auth, switchTo } = await browser('/selfie');
  const { stop } = await camera();
  // Stop the first camera by capturing, then start a fresh pending request.
  await takePhoto();
  fireEvent.click(screen.getByRole('button', { name: 'Retake photo' }));
  const pending = deferred<MediaStream>();
  const lateStop = vi.fn();
  vi.mocked(navigator.mediaDevices.getUserMedia).mockReturnValueOnce(pending.promise);
  fireEvent.click(screen.getByRole('button', { name: 'Turn on front camera' }));
  switchTo('b'); act(() => auth.adoptSession('b'));
  await act(async () => pending.resolve({ getTracks: () => [{ stop: lateStop }] } as unknown as MediaStream));
  expect(stop).toHaveBeenCalled();
  expect(lateStop).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole('button', { name: 'Take photo now' })).toBeNull();
});
it('AX356 F3 proves the capture epoch at Save when a cross-tab notification was missed', async () => {
  const { fetcher, switchTo } = await browser('/selfie'); await camera(); await takePhoto(); switchTo('b');
  fireEvent.click(screen.getByRole('button', { name: 'Save captured photo and continue' }));
  await act(async () => undefined);
  expect(fetcher.mock.calls.some(([url]) => String(url).endsWith('/auth/selfie'))).toBe(false);
  expect(screen.queryByAltText('Captured profile photo preview')).toBeNull();
});
it('AX356 F3 rejects Save if the epoch changes while its identity proof is pending', async () => {
  const { auth, fetcher, switchTo } = await browser('/selfie'); await camera(); await takePhoto();
  const proof = deferred<Response>(); fetcher.mockReturnValueOnce(proof.promise);
  fireEvent.click(screen.getByRole('button', { name: 'Save captured photo and continue' }));
  switchTo('b'); act(() => auth.adoptSession('b'));
  await act(async () => proof.resolve(response({ user: { id: 'a' } })));
  expect(fetcher.mock.calls.some(([url]) => String(url).endsWith('/auth/selfie'))).toBe(false);
});
it('AX356 F3 same-session Save keeps the store item continuation', async () => {
  const { fetcher } = await browser('/selfie'); await camera(); await takePhoto();
  fireEvent.click(screen.getByRole('button', { name: 'Save captured photo and continue' }));
  await waitFor(() => expect(route.router.replace).toHaveBeenCalledWith('/store/test?item=meal'));
  expect(fetcher.mock.calls.filter(([url]) => String(url).endsWith('/auth/selfie'))).toHaveLength(1);
});
async function signup(role: 'VENDOR' | 'MOVER') {
  const { default: Signup } = await import('@/app/signup/page'); render(<Signup />);
  const form = screen.getByRole('main');
  fireEvent.click(screen.getByRole('button', { name: role === 'VENDOR' ? /Put my business/ : /Drive & deliver/ }));
  fireEvent.change(screen.getByLabelText('Phone number'), { target: { value: '+5926001003' } });
  fireEvent.click(screen.getByRole('button', { name: 'Send code' }));
  fireEvent.change(await screen.findByLabelText('Verification code'), { target: { value: '246810' } });
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
  fireEvent.change(await screen.findByLabelText('First name'), { target: { value: 'PrivateFirstA' } });
  fireEvent.change(screen.getByLabelText('Last name'), { target: { value: 'PrivateLastA' } });
  fireEvent.click(screen.getByRole('button', { name: 'Create account' }));
  return form;
}
it.each(['VENDOR', 'MOVER'] as const)('AX356 F4 resets %s onboarding after registration advances the epoch and another account signs in', async (role) => {
  const { auth, fetcher, switchTo } = await browser('/signup'); const initial = auth.currentSessionEpoch(); const form = await signup(role);
  const label = role === 'VENDOR' ? 'Business name' : 'Licence plate';
  fireEvent.change(await screen.findByLabelText(label), { target: { value: 'PrivateDraftA' } });
  expect(auth.currentSessionEpoch()).toBe(initial + 1);
  // A separate QR continuation hook must not receive an unmount when the
  // session that registration just created resets these private fields.
  expect(screen.getByRole('main')).toBe(form);
  switchTo('b'); act(() => auth.adoptSession('b'));
  expect(screen.queryByDisplayValue('PrivateDraftA')).toBeNull(); expect(screen.queryByLabelText(label)).toBeNull();
  expect(screen.getByRole('heading', { name: 'What brings you to Swift?' })).toBeTruthy();
  expect(fetcher.mock.calls.some(([url]) => String(url).endsWith('/partner/become'))).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: /Put my business/ }));
  expect((screen.getByLabelText('Phone number') as HTMLInputElement).value).toBe('+592');
});
it('AX356 F4 clears the OTP draft and ignores a late send after an account change', async () => {
  const { auth, fetcher, switchTo } = await browser('/signup');
  const { default: Signup } = await import('@/app/signup/page'); render(<Signup />);
  fireEvent.click(screen.getByRole('button', { name: /Put my business/ }));
  fireEvent.change(screen.getByLabelText('Phone number'), { target: { value: '+5926001003' } });
  const send = deferred<Response>(); fetcher.mockReturnValueOnce(send.promise);
  fireEvent.click(screen.getByRole('button', { name: 'Send code' }));
  switchTo('b'); act(() => auth.adoptSession('b'));
  await act(async () => send.resolve(response({})));
  expect(screen.getByRole('heading', { name: 'What brings you to Swift?' })).toBeTruthy();
  expect(screen.queryByDisplayValue('+5926001003')).toBeNull();
  expect(screen.queryByLabelText('Verification code')).toBeNull();
});
it('AX356 F4 rejects a complete vehicle draft when submission discovers a missed account switch', async () => {
  const { fetcher, switchTo } = await browser('/signup');
  await signup('MOVER');
  await screen.findByLabelText('Licence plate');
  for (const [label, value] of [['Make', 'TestMakeA'], ['Model', 'TestModelA'], ['Year', '2020'], ['Colour', 'TestColourA'], ['Licence plate', 'TestPlateA']]) {
    fireEvent.change(screen.getByLabelText(label!), { target: { value } });
  }
  switchTo('b');
  fireEvent.click(screen.getByRole('button', { name: 'Create driver account' }));
  await screen.findByRole('heading', { name: 'What brings you to Swift?' });
  expect(fetcher.mock.calls.some(([url]) => String(url).endsWith('/partner/become'))).toBe(false);
  expect(screen.queryByDisplayValue('TestPlateA')).toBeNull();
});
