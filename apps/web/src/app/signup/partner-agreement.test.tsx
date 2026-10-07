import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import SignupPage from './page';

// ---------------------------------------------------------------------------
// Partner sign-up on the web needs the partner agreement, as the apps do.
// The API refuses /partner/become without acceptAgreement: true (it records
// the consent), so a web partner sign-up without it always failed. The owner
// must tick an explicit, unticked-by-default box naming the agreement (with a
// link to read it); the button stays disabled until then; and the agreement is
// sent only when ticked. A refusal from the server is shown as it is.
// ---------------------------------------------------------------------------

const fx = vi.hoisted(() => ({
  send: vi.fn(), verify: vi.fn(), register: vi.fn(), become: vi.fn(), replace: vi.fn(), probe: vi.fn(),
  search: vi.fn(), details: vi.fn(), api: vi.fn(),
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: fx.replace }) }));
vi.mock('@/lib/auth', () => ({ sendOtp: fx.send, sessionProbe: fx.probe, apiFetch: fx.api }));
vi.mock('@/lib/customer', () => ({
  verifyOtp: fx.verify, registerAccount: fx.register, becomePartner: fx.become,
  placesAutocomplete: fx.search, placeDetails: fx.details,
}));
vi.mock('@/lib/geolocate', () => ({ currentCoords: vi.fn() }));

const DOOR = { placeId: 'door', primary: '12 Regent Street', secondary: 'Georgetown', lat: 6.812, lng: -58.163 };
const loadMap = () => screen.getByRole('application').querySelectorAll('img').forEach((tile) => fireEvent.load(tile));

const AGREEMENT_REFUSED = 'Accept the driver agreement to continue — Swift records that you agreed, and cannot record what you did not.';
const disabled = (name: string) => (screen.getByRole('button', { name }) as HTMLButtonElement).disabled;

beforeEach(() => {
  vi.resetAllMocks();
  fx.send.mockResolvedValue(undefined);
  fx.verify.mockResolvedValue({ signedIn: false, isNewUser: true });
  fx.register.mockResolvedValue({});
  fx.become.mockResolvedValue({});
  fx.probe.mockResolvedValue({ ok: false });
  fx.search.mockResolvedValue([DOOR]);
  fx.api.mockResolvedValue({ data: { address: 'Store entrance, Georgetown' } });
  window.history.replaceState(null, '', '/signup');
});

const back = (user: ReturnType<typeof userEvent.setup>) => user.click(screen.getByRole('button', { name: 'Go back one signup step' }));

/** From the role step: phone, code and name, as a new account. */
async function newAccount(user: ReturnType<typeof userEvent.setup>, tile: RegExp, phone: string) {
  await user.click(screen.getByRole('button', { name: tile }));
  fireEvent.change(screen.getByLabelText('Phone number'), { target: { value: phone } });
  await user.click(screen.getByRole('button', { name: 'Send code' }));
  fireEvent.change(await screen.findByLabelText('Verification code'), { target: { value: '246810' } });
  await user.click(screen.getByRole('button', { name: 'Continue' }));
  fireEvent.change(await screen.findByLabelText('First name'), { target: { value: 'Test' } });
  fireEvent.change(screen.getByLabelText('Last name'), { target: { value: 'Partner' } });
  await user.click(screen.getByRole('button', { name: 'Create account' }));
}

async function driverDetails() {
  const user = userEvent.setup();
  render(<SignupPage />);
  await user.click(screen.getByRole('button', { name: /Drive & deliver/ }));
  fireEvent.change(screen.getByLabelText('Phone number'), { target: { value: '+5926001004' } });
  await user.click(screen.getByRole('button', { name: 'Send code' }));
  fireEvent.change(await screen.findByLabelText('Verification code'), { target: { value: '246810' } });
  await user.click(screen.getByRole('button', { name: 'Continue' }));
  fireEvent.change(await screen.findByLabelText('First name'), { target: { value: 'Test' } });
  fireEvent.change(screen.getByLabelText('Last name'), { target: { value: 'Driver' } });
  await user.click(screen.getByRole('button', { name: 'Create account' }));
  for (const [label, value] of [['Make', 'Toyota'], ['Model', 'Axio'], ['Year', '2018'], ['Colour', 'Silver'], ['Licence plate', 'PAA 1234']]) {
    fireEvent.change(await screen.findByLabelText(label!), { target: { value } });
  }
  return user;
}

describe('web partner sign-up records the partner agreement', () => {
  it('driver: the box is unticked, links to the agreement, and the button waits for it', async () => {
    const user = await driverDetails();
    const box = screen.getByRole('checkbox', { name: /I agree to the Driver Partner Agreement/ }) as HTMLInputElement;
    expect(box.checked).toBe(false);
    const link = screen.getByRole('link', { name: 'Driver Partner Agreement' }) as HTMLAnchorElement;
    expect(link.href).toMatch(/\/legal\/driver-agreement$/);
    expect(disabled('Create driver account')).toBe(true);
    await user.click(screen.getByRole('button', { name: 'Create driver account' }));
    expect(fx.become).not.toHaveBeenCalled();

    await user.click(box);
    expect(disabled('Create driver account')).toBe(false);
    await user.click(screen.getByRole('button', { name: 'Create driver account' }));
    expect(fx.become).toHaveBeenCalledTimes(1);
    expect(fx.become.mock.calls[0]![0]).toMatchObject({ role: 'MOVER', acceptAgreement: true });
    expect(fx.replace).toHaveBeenCalledWith('/portal');
  });

  it('unticking again disables the button and nothing is sent', async () => {
    const user = await driverDetails();
    const box = screen.getByRole('checkbox', { name: /I agree to the Driver Partner Agreement/ });
    await user.click(box);
    await user.click(box);
    expect(disabled('Create driver account')).toBe(true);
    expect(fx.become).not.toHaveBeenCalled();
  });

  it('the server’s agreement refusal is shown as it is', async () => {
    fx.become.mockRejectedValue(new Error(AGREEMENT_REFUSED));
    const user = await driverDetails();
    await user.click(screen.getByRole('checkbox', { name: /I agree to the Driver Partner Agreement/ }));
    await user.click(screen.getByRole('button', { name: 'Create driver account' }));
    expect((await screen.findByRole('alert')).textContent).toBe(AGREEMENT_REFUSED);
    expect(fx.replace).not.toHaveBeenCalled();
  });

  it('business: an unticked box naming the Vendor Partner Agreement, linking to it', async () => {
    const user = userEvent.setup();
    render(<SignupPage />);
    await user.click(screen.getByRole('button', { name: /Put my business on Swift/ }));
    fireEvent.change(screen.getByLabelText('Phone number'), { target: { value: '+5926001005' } });
    await user.click(screen.getByRole('button', { name: 'Send code' }));
    fireEvent.change(await screen.findByLabelText('Verification code'), { target: { value: '246810' } });
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    fireEvent.change(await screen.findByLabelText('First name'), { target: { value: 'Test' } });
    fireEvent.change(screen.getByLabelText('Last name'), { target: { value: 'Merchant' } });
    await user.click(screen.getByRole('button', { name: 'Create account' }));
    const box = (await screen.findByRole('checkbox', { name: /I agree to the Vendor Partner Agreement/ })) as HTMLInputElement;
    expect(box.checked).toBe(false);
    expect((screen.getByRole('link', { name: 'Vendor Partner Agreement' }) as HTMLAnchorElement).href).toMatch(/\/legal\/vendor-agreement$/);
  });

  it('a tick given for the Driver agreement is not carried to the Vendor agreement', async () => {
    const user = await driverDetails();
    await user.click(screen.getByRole('checkbox', { name: /I agree to the Driver Partner Agreement/ }));
    for (let i = 0; i < 4; i += 1) await back(user); // vehicle -> name -> code -> phone -> role
    await newAccount(user, /Put my business on Swift/, '+5926001007');
    const box = (await screen.findByRole('checkbox', { name: /I agree to the Vendor Partner Agreement/ })) as HTMLInputElement;
    expect(box.checked).toBe(false);
    expect(fx.become).not.toHaveBeenCalled();
  });

  it('leaving the agreement step and coming back shows the box unticked again', async () => {
    const user = await driverDetails();
    await user.click(screen.getByRole('checkbox', { name: /I agree to the Driver Partner Agreement/ }));
    await back(user); // vehicle -> name
    await user.click(screen.getByRole('button', { name: 'Create account' }));
    const box = (await screen.findByRole('checkbox', { name: /I agree to the Driver Partner Agreement/ })) as HTMLInputElement;
    expect(box.checked).toBe(false);
    expect(disabled('Create driver account')).toBe(true);
  });
});

describe('a signed-in business account without a store resumes at the business step', () => {
  it('/signup?resume=business opens the business step with the account’s phone, and the business is created with that phone', async () => {
    fx.probe.mockResolvedValue({ ok: true, user: { id: 'u1', phone: '+5926001006' } });
    window.history.replaceState(null, '', '/signup?resume=business');
    const user = userEvent.setup();
    render(<SignupPage />);
    expect(await screen.findByRole('heading', { name: 'Your business' })).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Business name'), { target: { value: 'Test shop' } });
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
    await user.click(screen.getByRole('button', { name: 'Create business' }));
    expect(fx.become).toHaveBeenCalledTimes(1);
    expect(fx.become.mock.calls[0]![0]).toMatchObject({ role: 'VENDOR', acceptAgreement: true, business: { phone: '+5926001006' } });
    expect(fx.replace).toHaveBeenCalledWith('/dashboard');
  });

  it('without a session it is the ordinary sign-up', async () => {
    window.history.replaceState(null, '', '/signup?resume=business');
    render(<SignupPage />);
    await screen.findByRole('button', { name: /Put my business on Swift/ });
    expect(screen.queryByRole('heading', { name: 'Your business' })).toBeNull();
  });
});
