import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import SignupPage from './page';
import { AGREEMENT, EXAMPLE, LIMIT, NAME_AS_ON_ID } from '@/lib/signup-fields';
import { isHirePlate } from '@/lib/signup-roles';

// ---------------------------------------------------------------------------
// [WEB-ONBOARDING · owner 1 Nov 2026] "Before they type, an example has to be in the box, and if not they don't
// know what to do; when they type it disappears." Every box of the partner sign-up shows a greyed example (a
// placeholder: the browser removes it as soon as something is typed), takes no more than the server keeps, and while
// the button waits one line names the first thing missing, in the app's words. The agreements carry the documents'
// own titles. The last block holds the limits to the server's schemas and the words to the app's.
// ---------------------------------------------------------------------------

const fx = vi.hoisted(() => ({
  send: vi.fn(), verify: vi.fn(), register: vi.fn(), become: vi.fn(), sign: vi.fn(), replace: vi.fn(), probe: vi.fn(), search: vi.fn(), api: vi.fn(),
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: fx.replace }) }));
vi.mock('@/lib/auth', () => ({ sendOtp: fx.send, sessionProbe: fx.probe, apiFetch: fx.api }));
// [SIGNUP-PHONE #2300] the code is sent from its own module now
vi.mock('@/lib/otp-send', () => ({ sendOtp: fx.send }));
vi.mock('@/lib/customer-account', () => ({ verifyOtp: fx.verify, registerAccount: fx.register, becomePartner: fx.become, signOwnName: fx.sign }));
vi.mock('@/lib/customer-places', () => ({ placesAutocomplete: fx.search, placeDetails: vi.fn() }));
vi.mock('@/lib/geolocate', () => ({ currentCoords: vi.fn() }));
vi.mock('./weekly-fee-loader', () => ({ loadWeeklyFee: () => import('@/test/weekly-fee-fixture') }));

const DOOR = { placeId: 'door', primary: '12 Regent Street', secondary: 'Georgetown', lat: 6.812, lng: -58.163 };
const loadMap = () => screen.getByRole('application').querySelectorAll('img').forEach((tile) => fireEvent.load(tile));
const box = (label: string) => screen.getByLabelText(label) as HTMLInputElement;
const ask = () => document.querySelector('[data-signup-ask]')?.textContent ?? null;
const button = (name: string) => screen.getByRole('button', { name }) as HTMLButtonElement;
const type = (label: string, value: string) => fireEvent.change(box(label), { target: { value } });

beforeEach(() => {
  vi.resetAllMocks();
  fx.send.mockResolvedValue(undefined);
  fx.verify.mockResolvedValue({ signedIn: false, isNewUser: true });
  fx.register.mockResolvedValue({});
  fx.become.mockResolvedValue({});
  fx.sign.mockResolvedValue({});
  fx.probe.mockResolvedValue({ ok: false });
  fx.search.mockResolvedValue([DOOR]);
  fx.api.mockResolvedValue({ data: { address: 'Store entrance, Georgetown' } });
  window.history.replaceState(null, '', '/signup');
});

/** Through the phone, the code and onto the name step, as a partner door. */
async function toName(tile: RegExp) {
  const user = userEvent.setup();
  render(<SignupPage />);
  await user.click(screen.getByRole('button', { name: tile }));
  fireEvent.change(screen.getByLabelText('Phone number'), { target: { value: '+5926001234' } });
  await user.click(screen.getByRole('button', { name: 'Send code' }));
  fireEvent.change(await screen.findByLabelText('Verification code'), { target: { value: '246810' } });
  await user.click(screen.getByRole('button', { name: 'Continue' }));
  await screen.findByLabelText('First name');
  return user;
}

async function toVehicle(tile: RegExp) {
  const user = await toName(tile);
  type('First name', 'Test');
  type('Last name', 'Partner');
  await user.click(screen.getByRole('checkbox', { name: /Terms of Service/ }));
  await user.click(screen.getByRole('checkbox', { name: /18 or older/ }));
  await user.click(screen.getByRole('button', { name: 'Create account' }));
  await screen.findByLabelText('Vehicle');
  return user;
}

/** A signed-in account without a store comes back straight to the business step. */
async function toBusiness() {
  fx.probe.mockResolvedValue({ ok: true, user: { id: 'u1', phone: '+5926001008' } });
  window.history.replaceState(null, '', '/signup?resume=business');
  const user = userEvent.setup();
  render(<SignupPage />);
  await screen.findByRole('heading', { name: 'Your business' });
  return user;
}

describe('[WEB-ONBOARDING] an example in every box, and no more than the server keeps', () => {
  it('the name step: an example in each name box, and a partner is told to use the name on their ID', async () => {
    await toName(/Drive a taxi with Swift/);
    expect(box('First name').placeholder).toBe('e.g. Asha');
    expect(box('Last name').placeholder).toBe('e.g. Persaud');
    expect(box('First name').maxLength).toBe(50);
    expect(box('Last name').maxLength).toBe(50);
    expect(screen.getByText(NAME_AS_ON_ID)).toBeTruthy();
  });

  it('the business step: an example in each box, the server’s limits, and the region is optional', async () => {
    await toBusiness();
    const expected: [string, string, number][] = [
      ['Business name', 'e.g. Corner Basket', 120],
      ['Street address', 'e.g. 12 Regent Street', 200],
      ['City or town', 'e.g. Georgetown', 80],
      ['Region (optional)', 'e.g. Demerara-Mahaica', 80],
    ];
    for (const [label, example, limit] of expected) {
      expect(box(label).placeholder, label).toBe(example);
      expect(box(label).maxLength, label).toBe(limit);
    }
  });

  it('a store under its owner’s own name is shown a surname as the example', async () => {
    const user = await toBusiness();
    await user.click(await screen.findByRole('radio', { name: /My own name — just my surname/ }));
    expect(box('Business name').placeholder).toBe('e.g. R. Persaud');
    await user.click(screen.getByRole('radio', { name: 'A business name, or a company' }));
    expect(box('Business name').placeholder).toBe('e.g. Corner Basket');
  });

  it('the taxi step: an example in each box (the plate an H plate the server takes), the limits, capitals on the plate', async () => {
    await toVehicle(/Drive a taxi with Swift/);
    const expected: [string, string, number][] = [
      ['Make', 'e.g. Toyota', 60], ['Model', 'e.g. Allion', 60], ['Year', 'e.g. 2016', 4], ['Colour', 'e.g. Silver', 40], ['Licence plate', 'e.g. HC 1234', 20],
    ];
    for (const [label, example, limit] of expected) {
      expect(box(label).placeholder, label).toBe(example);
      expect(box(label).maxLength, label).toBe(limit);
    }
    expect(isHirePlate(EXAMPLE.plate.replace('e.g. ', ''))).toBe(true);
    expect(box('Licence plate').getAttribute('autocapitalize')).toBe('characters');
  });
});

describe('[WEB-ONBOARDING] while the button waits, one line says what is missing', () => {
  it('a store: a 2-letter name, a 3-letter street, a 2-letter town, the map pin, then the agreement; no region needed', async () => {
    const user = await toBusiness();
    const create = () => button('Create business');
    expect(ask()).toBe('Name your business');
    type('Business name', 'A');
    expect(ask()).toBe('Name your business');
    expect(create().disabled).toBe(true);
    type('Business name', 'Test shop');
    expect(ask()).toBe('Add the street address');
    type('Street address', '12');
    expect(ask()).toBe('Add the street address');
    type('Street address', '12 Regent Street');
    expect(ask()).toBe('Add the city or town');
    type('City or town', 'G');
    expect(ask()).toBe('Add the city or town');
    type('City or town', 'Georgetown');
    expect(ask()).toBe('Place your store on the map');
    expect(create().disabled).toBe(true);

    await user.click(button('Place your store on the map'));
    await screen.findByRole('button', { name: /12 Regent Street.*Georgetown/ });
    loadMap();
    await user.click(screen.getByRole('button', { name: /12 Regent Street.*Georgetown/ }));
    loadMap();
    await user.click(screen.getByRole('button', { name: 'Confirm store location' }));
    await waitFor(() => expect(ask()).toBe('Tick the Business Agreement to continue'));
    expect(create().disabled).toBe(true);

    await user.click(screen.getByRole('checkbox', { name: /I agree to the Business Agreement/ }));
    expect(ask()).toBeNull();
    expect(box('Region (optional)').value).toBe('');
    expect(create().disabled).toBe(false);
    await user.click(create());
    expect(fx.become).toHaveBeenCalledTimes(1);
    expect(fx.become.mock.calls[0]![0].business).toMatchObject({ name: 'Test shop', addressLine1: '12 Regent Street', city: 'Georgetown', region: '' });
  });

  it('a taxi: make, model, a year from 1980 to next year, colour, plate, then the agreement', async () => {
    const user = await toVehicle(/Drive a taxi with Swift/);
    const create = () => button('Create driver account');
    const next = new Date().getFullYear() + 1;
    expect(ask()).toBe('Add the make');
    type('Make', 'Toyota');
    expect(ask()).toBe('Add the model');
    type('Model', 'Allion');
    expect(ask()).toBe(`Add the year the car was made: 1980 to ${next}`);
    type('Year', '1979');
    expect(ask()).toBe(`Add the year the car was made: 1980 to ${next}`);
    type('Year', '2016');
    expect(ask()).toBe('Add the colour');
    type('Colour', 'Silver');
    expect(ask()).toBe('Add the licence plate');
    type('Licence plate', 'HC 1234');
    await waitFor(() => expect(ask()).toBe('Tick the Mover Agreement to continue'));
    expect(create().disabled).toBe(true);
    await user.click(screen.getByRole('checkbox', { name: /I agree to the Mover Agreement/ }));
    expect(ask()).toBeNull();
    expect(create().disabled).toBe(false);
  });

  it('a delivery rider: only the agreement', async () => {
    const user = await toVehicle(/Deliver with Swift/);
    // The weekly fee block loads on this step and speaks first; then the agreement is what is missing.
    await waitFor(() => expect(ask()).toBe('Tick the Mover Agreement to continue'));
    await user.click(screen.getByRole('checkbox', { name: /I agree to the Mover Agreement/ }));
    expect(ask()).toBeNull();
    expect(button('Create rider account').disabled).toBe(false);
  });
});

describe('[WEB-ONBOARDING] each agreement by its own title', () => {
  it('a store ticks the Business Agreement; riders and taxi drivers the Mover Agreement', async () => {
    await toBusiness();
    expect((screen.getByRole('link', { name: AGREEMENT.business }) as HTMLAnchorElement).href).toMatch(/\/legal\/vendor-agreement$/);
    expect(screen.queryByText(/Partner Agreement/)).toBeNull();
  });

  it('the mover doors', async () => {
    await toVehicle(/Deliver with Swift/);
    expect((screen.getByRole('link', { name: AGREEMENT.mover }) as HTMLAnchorElement).href).toMatch(/\/legal\/driver-agreement$/);
    expect(screen.queryByText(/Partner Agreement/)).toBeNull();
  });
});

describe('[WEB-ONBOARDING] the limits are the server’s, the examples and words the app’s', () => {
  const repo = (path: string) => readFileSync(join(__dirname, '..', '..', '..', '..', '..', path), 'utf8');
  const max = (source: string, field: string) => Number(new RegExp(`\\b${field}: z\\.string\\(\\)[^\\n]*?\\.max\\((\\d+)\\)`).exec(source)?.[1]);
  const min = (source: string, field: string) => Number(new RegExp(`\\b${field}: z\\.string\\(\\)[^\\n]*?\\.min\\((\\d+)\\)`).exec(source)?.[1]);

  it('every limit is the server’s own', () => {
    const business = repo('apps/api/src/modules/partner/business-input.ts');
    const vehicle = repo('apps/api/src/modules/partner/partner.routes.ts');
    const register = repo('apps/api/src/modules/auth/auth.routes.ts');
    expect([max(business, 'name'), max(business, 'addressLine1'), max(business, 'city'), max(business, 'region')]).toEqual([LIMIT.business, LIMIT.street, LIMIT.city, LIMIT.region]);
    expect([max(vehicle, 'make'), max(vehicle, 'model'), max(vehicle, 'color'), max(vehicle, 'licensePlate')]).toEqual([LIMIT.make, LIMIT.model, LIMIT.color, LIMIT.plate]);
    expect([max(register, 'firstName'), max(register, 'lastName')]).toEqual([LIMIT.name, LIMIT.name]);
    // The asks hold the server's shortest values: a business name of 2, a street of 3, a town of 2.
    expect([min(business, 'name'), min(business, 'addressLine1'), min(business, 'city')]).toEqual([2, 3, 2]);
    expect(business).toMatch(/region: z\.string\(\)\.trim\(\)\.max\(80\)\.optional\(\)/);
    expect(vehicle).toMatch(/year: z\.number\(\)\.int\(\)\.min\(1980\)\.max\(new Date\(\)\.getFullYear\(\) \+ 1\)/);
  });

  it('the examples and the asks are the app’s; the plate example is the server’s own', () => {
    const mover = repo('apps/mobile/src/modules/mover/screens/MoverOnboardingScreen.tsx');
    expect(mover).toContain(`placeholder="Make (${EXAMPLE.make})"`);
    expect(mover).toContain(`placeholder="Model (${EXAMPLE.model})"`);
    const blocker = repo('apps/mobile/src/lib/storePin.ts');
    for (const words of ["form.name.trim().length < 2) return 'Name your business'", "form.addr.trim().length < 3) return 'Add the street address'", "return 'Place your store on the map'"]) {
      expect(blocker).toContain(words);
    }
    expect(repo('apps/api/src/modules/verification/hire-plate.ts')).toContain(EXAMPLE.plate);
    const legal = repo('apps/api/src/modules/legal/legal.routes.ts');
    expect(legal).toContain(`export const DRIVER_AGREEMENT = page(\n  '${AGREEMENT.mover}',`);
    expect(legal).toContain(`export const VENDOR_AGREEMENT = page(\n  '${AGREEMENT.business}',`);
  });
});
