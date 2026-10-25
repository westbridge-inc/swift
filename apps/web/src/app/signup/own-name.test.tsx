import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OWN_NAME_DECLARATION_WEB } from '@/lib/own-name-copy';
import SignupPage from './page';

// ---------------------------------------------------------------------------
// [ROLE-DOCS · owner ruling 21 Oct 2026 · #2046] A store may trade under its owner's own name (BNA s.3). On the
// web sign-up the owner picks it on the business step, reads the declaration and ticks it; the store is created
// with nameBasis OWN_NAME and the declaration is signed right after. The choice and the declaration's words load
// on demand (own-name-loader.ts; page-size.test.ts) — this file proves the owner still sees and signs them.
// ---------------------------------------------------------------------------

const fx = vi.hoisted(() => ({
  become: vi.fn(), sign: vi.fn(), replace: vi.fn(), probe: vi.fn(), search: vi.fn(), api: vi.fn(), loadFails: { n: 0 },
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: fx.replace }) }));
vi.mock('@/lib/auth', () => ({ sendOtp: vi.fn(), sessionProbe: fx.probe, apiFetch: fx.api }));
vi.mock('@/lib/customer-account', () => ({ verifyOtp: vi.fn(), registerAccount: vi.fn(), becomePartner: fx.become, signOwnName: fx.sign }));
vi.mock('@/lib/customer-places', () => ({ placesAutocomplete: fx.search, placeDetails: vi.fn() }));
vi.mock('@/lib/geolocate', () => ({ currentCoords: vi.fn() }));
vi.mock('./weekly-fee-loader', () => ({ loadWeeklyFee: () => import('@/test/weekly-fee-fixture') }));
vi.mock('./own-name-loader', async () => {
  const real = await vi.importActual<typeof import('./own-name-loader')>('./own-name-loader');
  return { loadOwnNameChoice: () => (fx.loadFails.n-- > 0 ? Promise.reject(new Error('chunk')) : real.loadOwnNameChoice()) };
});

const DOOR = { placeId: 'door', primary: '12 Regent Street', secondary: 'Georgetown', lat: 6.812, lng: -58.163 };
const loadMap = () => screen.getByRole('application').querySelectorAll('img').forEach((tile) => fireEvent.load(tile));
const OWN = /My own name — just my surname/;

beforeEach(() => {
  vi.resetAllMocks();
  fx.loadFails.n = 0;
  fx.become.mockResolvedValue({});
  fx.sign.mockResolvedValue({});
  fx.probe.mockResolvedValue({ ok: true, user: { id: 'u1', phone: '+5926001008' } });
  fx.search.mockResolvedValue([DOOR]);
  fx.api.mockResolvedValue({ data: { address: 'Store entrance, Georgetown' } });
  window.history.replaceState(null, '', '/signup?resume=business');
});

/** The business step (a signed-in account without a store), filled in, store placed, agreement ticked. */
async function businessStep(storeName = 'Persaud') {
  const user = userEvent.setup();
  render(<SignupPage />);
  expect(await screen.findByRole('heading', { name: 'Your business' })).toBeTruthy();
  fireEvent.change(screen.getByLabelText('Business name'), { target: { value: storeName } });
  for (const [label, value] of [['Street address', '12 Regent Street'], ['City or town', 'Georgetown'], ['Region', 'Demerara-Mahaica']]) {
    fireEvent.change(screen.getByLabelText(label!), { target: { value } });
  }
  await user.click(screen.getByRole('checkbox', { name: /I agree to the Vendor Partner Agreement/ }));
  await user.click(screen.getByRole('button', { name: 'Place your store on the map' }));
  await screen.findByRole('button', { name: /12 Regent Street.*Georgetown/ });
  loadMap();
  await user.click(screen.getByRole('button', { name: /12 Regent Street.*Georgetown/ }));
  loadMap();
  await user.click(screen.getByRole('button', { name: 'Confirm store location' }));
  return user;
}

describe('[ROLE-DOCS] the web sign-up offers and signs the own-name declaration', () => {
  it('shows the choice (business name by default) and, for own name, the declaration’s exact words for this store', async () => {
    const user = await businessStep();
    const own = (await screen.findByRole('radio', { name: OWN })) as HTMLInputElement;
    expect(own.checked).toBe(false);
    expect((screen.getByRole('radio', { name: 'A business name, or a company' }) as HTMLInputElement).checked).toBe(true);
    expect(screen.queryByText(/I TRADE UNDER MY OWN NAME/)).toBeNull();
    await user.click(own);
    expect(document.querySelector('pre')?.textContent).toBe(OWN_NAME_DECLARATION_WEB);
    expect(screen.getByText('You sign this for “Persaud” only.')).toBeTruthy();
    expect((screen.getByRole('checkbox', { name: 'I have read the declaration above and I sign it.' }) as HTMLInputElement).checked).toBe(false);
  });

  it('own name without the tick creates nothing; with the tick the store is created as own-name, then signed', async () => {
    const user = await businessStep();
    await user.click(await screen.findByRole('radio', { name: OWN }));
    await user.click(screen.getByRole('button', { name: 'Create business' }));
    expect((await screen.findByRole('alert')).textContent).toBe('Sign the own-name declaration to continue');
    expect(fx.become).not.toHaveBeenCalled();
    expect(fx.sign).not.toHaveBeenCalled();

    await user.click(screen.getByRole('checkbox', { name: 'I have read the declaration above and I sign it.' }));
    await user.click(screen.getByRole('button', { name: 'Create business' }));
    expect(fx.become).toHaveBeenCalledTimes(1);
    expect(fx.become.mock.calls[0]![0]).toMatchObject({ role: 'VENDOR', business: { name: 'Persaud', nameBasis: 'OWN_NAME' } });
    expect(fx.sign).toHaveBeenCalledTimes(1);
    expect(fx.become.mock.invocationCallOrder[0]!).toBeLessThan(fx.sign.mock.invocationCallOrder[0]!);
    expect(fx.replace).toHaveBeenCalledWith('/dashboard');
  });

  it('a business name sends no nameBasis and signs nothing', async () => {
    const user = await businessStep('Test shop');
    await screen.findByRole('radio', { name: OWN });
    await user.click(screen.getByRole('button', { name: 'Create business' }));
    expect(fx.become).toHaveBeenCalledTimes(1);
    expect(fx.become.mock.calls[0]![0].business).not.toHaveProperty('nameBasis');
    expect(fx.sign).not.toHaveBeenCalled();
  });

  it('a services business is never offered the choice', async () => {
    await businessStep('Test services');
    await screen.findByRole('radio', { name: OWN });
    fireEvent.change(screen.getByLabelText('Business type'), { target: { value: 'SERVICE' } });
    expect(screen.queryByRole('radio', { name: OWN })).toBeNull();
  });

  it('a failed load of the choice offers a retry that brings it back (nothing typed is lost)', async () => {
    fx.loadFails.n = 1;
    const user = await businessStep();
    await user.click(await screen.findByRole('button', { name: 'Couldn’t load the store-name choice — try again' }));
    expect(await screen.findByRole('radio', { name: OWN })).toBeTruthy();
    expect((screen.getByLabelText('Business name') as HTMLInputElement).value).toBe('Persaud');
  });
});
