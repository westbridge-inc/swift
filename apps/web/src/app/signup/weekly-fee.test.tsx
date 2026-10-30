import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import SignupPage from './page';
import { FEE_TERMS_V1, SIGNUP_PRICING } from '@/test/weekly-fee-fixture';

// ---------------------------------------------------------------------------
// [COORD ruling 22 Oct 2026 · row 628] The weekly fee at partner sign-up, on the website. Before
// the button that signs a store, rider or taxi driver up, the page shows the server's amount for
// THEIR business type or vehicle, the server's words (what it covers, when it starts, how it is
// paid, the 14-day rule) and an unticked "I understand the weekly fee". The button waits for the
// fee to be on screen and ticked; the tick is sent with the amount on screen; a refusal because
// the fee changed reads the price again and clears the tick. Nobody pays here.
// ---------------------------------------------------------------------------

const fx = vi.hoisted(() => ({ send: vi.fn(), verify: vi.fn(), register: vi.fn(), become: vi.fn(), replace: vi.fn(), probe: vi.fn(), fetch: vi.fn(), api: vi.fn(), search: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: fx.replace }) }));
vi.mock('@/lib/auth', () => ({ sendOtp: fx.send, sessionProbe: fx.probe, apiFetch: fx.api }));
vi.mock('@/lib/customer-account', () => ({ verifyOtp: fx.verify, registerAccount: fx.register, becomePartner: fx.become }));
vi.mock('@/lib/customer-places', () => ({ placesAutocomplete: fx.search, placeDetails: vi.fn() }));
vi.mock('@/lib/geolocate', () => ({ currentCoords: vi.fn() }));

const served = (data: unknown) => Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, data }) });

beforeEach(() => {
  vi.resetAllMocks();
  fx.send.mockResolvedValue(undefined);
  fx.verify.mockResolvedValue({ signedIn: false, isNewUser: true });
  fx.register.mockResolvedValue({});
  fx.become.mockResolvedValue({});
  fx.probe.mockResolvedValue({ ok: false });
  fx.fetch.mockImplementation(() => served(SIGNUP_PRICING));
  vi.stubGlobal('fetch', fx.fetch);
  window.history.replaceState(null, '', '/signup');
});
afterEach(() => { vi.unstubAllGlobals(); });

async function throughName(tile: RegExp) {
  const user = userEvent.setup();
  render(<SignupPage />);
  await user.click(screen.getByRole('button', { name: tile }));
  fireEvent.change(screen.getByLabelText('Phone number'), { target: { value: '+5926001234' } });
  await user.click(screen.getByRole('button', { name: 'Send code' }));
  fireEvent.change(await screen.findByLabelText('Verification code'), { target: { value: '246810' } });
  await user.click(screen.getByRole('button', { name: 'Continue' }));
  fireEvent.change(await screen.findByLabelText('First name'), { target: { value: 'Test' } });
  fireEvent.change(screen.getByLabelText('Last name'), { target: { value: 'Partner' } });
  await user.click(screen.getByRole('checkbox', { name: /Terms of Service/ }));
  await user.click(screen.getByRole('checkbox', { name: /18 or older/ }));
  await user.click(screen.getByRole('button', { name: 'Create account' }));
  return user;
}
const button = (name: string) => screen.getByRole('button', { name }) as HTMLButtonElement;
const feeBox = () => screen.findByRole('checkbox', { name: 'I understand the weekly fee.' }) as Promise<HTMLInputElement>;
const ACK = (amount: number) => ({ version: 'v1', amount, currencyCode: 'GYD' });

describe('[row 628] the weekly fee is on the page before a partner signs up', () => {
  it('a rider sees the fee for THEIR vehicle, every one of the server’s lines, and an unticked tick; the button waits for it', async () => {
    const user = await throughName(/Deliver with Swift/);
    const box = await feeBox();
    expect(box.checked).toBe(false);
    const fee = screen.getByRole('region', { name: 'Your weekly fee' });
    expect(fee.textContent).toContain('Your weekly fee: $6,000/week');
    for (const item of FEE_TERMS_V1.items) expect(fee.textContent).toContain(`${item.heading}: ${item.text}`);
    // The price is read fresh from the API, never a cached page's figure.
    expect(fx.fetch).toHaveBeenCalledWith(expect.stringMatching(/\/api\/v1\/auth\/pricing$/), expect.objectContaining({ cache: 'no-store' }));

    await user.click(screen.getByRole('checkbox', { name: /I agree to the Driver Partner Agreement/ }));
    expect(button('Create rider account').disabled).toBe(true);
    await user.click(button('Create rider account'));
    expect(fx.become).not.toHaveBeenCalled();

    await user.click(box);
    expect(button('Create rider account').disabled).toBe(false);
    await user.click(button('Create rider account'));
    expect(fx.become).toHaveBeenCalledExactlyOnceWith({ role: 'MOVER', acceptAgreement: true, weeklyFeeAck: ACK(6000), vehicleType: 'MOTORCYCLE' });
  });

  it('another vehicle is another fee: the amount changes and the tick is cleared, then sent with the new amount', async () => {
    const user = await throughName(/Deliver with Swift/);
    await user.click(await feeBox());
    await user.click(screen.getByRole('checkbox', { name: /I agree to the Driver Partner Agreement/ }));
    fireEvent.change(screen.getByLabelText('Vehicle'), { target: { value: 'BICYCLE' } });
    expect(screen.getByRole('region', { name: 'Your weekly fee' }).textContent).toContain('Your weekly fee: $5,000/week');
    expect((await feeBox()).checked).toBe(false);
    expect(button('Create rider account').disabled).toBe(true);
    await user.click(await feeBox());
    await user.click(button('Create rider account'));
    expect(fx.become.mock.calls[0]![0]).toMatchObject({ vehicleType: 'BICYCLE', weeklyFeeAck: ACK(5000) });
  });

  it('a taxi driver is quoted the taxi fee; a business its own type’s fee', async () => {
    const user = await throughName(/Drive a taxi with Swift/);
    expect((await screen.findByRole('region', { name: 'Your weekly fee' })).textContent).toContain('$8,000/week');
    for (const [label, value] of [['Make', 'Toyota'], ['Model', 'Axio'], ['Year', '2018'], ['Colour', 'Silver'], ['Licence plate', 'HAA 1234']]) {
      fireEvent.change(screen.getByLabelText(label!), { target: { value } });
    }
    await user.click(screen.getByRole('checkbox', { name: /I agree to the Driver Partner Agreement/ }));
    expect(button('Create driver account').disabled).toBe(true);
    await user.click(await feeBox());
    await user.click(button('Create driver account'));
    expect(fx.become.mock.calls[0]![0]).toMatchObject({ vehicleType: 'CAR', weeklyFeeAck: ACK(8000) });
  });

  it('a business sees the first step of its catalogue fee, or the services fee', async () => {
    await throughName(/Put my business on Swift/);
    const region = await screen.findByRole('region', { name: 'Your weekly fee' });
    expect(region.textContent).toContain('$9,000/week');
    fireEvent.change(screen.getByLabelText('Business type'), { target: { value: 'SERVICE' } });
    expect(screen.getByRole('region', { name: 'Your weekly fee' }).textContent).toContain('$7,000/week');
    expect(button('Create business').disabled).toBe(true);
  });

  it('[REVIEW-F S3-2] a catalogue store is told, beside the amount, that it is the starting rate; a services business is not', async () => {
    // [RETIER PR-A · R27] priced for its size when approved, ticked first; never "it steps up as you list more items"
    const LADDER = 'This is the starting rate. If your store has more active items by the time Swift approves it, its weekly fee is the rate for its size: you see that exact fee and tick it before anything is charged. After that, the rate does not change as your catalogue grows.';
    await throughName(/Put my business on Swift/);
    expect((await screen.findByRole('region', { name: 'Your weekly fee' })).textContent).toContain(`Your weekly fee: $9,000/week${LADDER}`);
    fireEvent.change(screen.getByLabelText('Business type'), { target: { value: 'SERVICE' } });
    expect(screen.getByRole('region', { name: 'Your weekly fee' }).textContent).not.toContain(LADDER);
  });

  it('[REVIEW-F S3-2] a price list with one catalogue step has nothing to step up to, and a rider has no catalogue', async () => {
    fx.fetch.mockImplementation(() => served({ ...SIGNUP_PRICING, vendors: { service: 7000, catalogue: [{ minItems: 0, rate: 9000 }] } }));
    await throughName(/Put my business on Swift/);
    expect((await screen.findByRole('region', { name: 'Your weekly fee' })).textContent).not.toMatch(/starting rate/);
  });

  it('[REVIEW-F S3-2] a rider sees no catalogue line', async () => {
    await throughName(/Deliver with Swift/);
    expect((await screen.findByRole('region', { name: 'Your weekly fee' })).textContent).not.toMatch(/starting rate/);
  });

  it('[REVIEW-F S4-1] with everything else done, "Create business" waits for the fee tick alone, then sends it', async () => {
    const DOOR = { placeId: 'door', primary: '12 Regent Street', secondary: 'Georgetown', lat: 6.812, lng: -58.163 };
    fx.search.mockResolvedValue([DOOR]);
    fx.api.mockResolvedValue({ data: { address: 'Store entrance, Georgetown' } });
    const user = await throughName(/Put my business on Swift/);
    fireEvent.change(await screen.findByLabelText('Business name'), { target: { value: 'Test shop' } });
    for (const [label, value] of [['Street address', '12 Regent Street'], ['City or town', 'Georgetown'], ['Region', 'Demerara-Mahaica']]) {
      fireEvent.change(screen.getByLabelText(label!), { target: { value } });
    }
    await user.click(screen.getByRole('checkbox', { name: /I agree to the Vendor Partner Agreement/ }));
    const loadMap = () => screen.getByRole('application').querySelectorAll('img').forEach((tile) => fireEvent.load(tile));
    await user.click(button('Place your store on the map'));
    await user.click(await screen.findByRole('button', { name: /12 Regent Street.*Georgetown/ }));
    loadMap();
    await user.click(button('Confirm store location'));
    const box = await feeBox();
    expect(button('Create business').disabled).toBe(true);
    await user.click(box);
    expect(button('Create business').disabled).toBe(false);
    await user.click(button('Create business'));
    expect(fx.become.mock.calls[0]![0]).toMatchObject({ role: 'VENDOR', acceptAgreement: true, weeklyFeeAck: ACK(9000) });
  });

  it('a price that does not load says so, keeps the button waiting, and can be tried again', async () => {
    fx.fetch.mockImplementationOnce(() => Promise.reject(new TypeError('Failed to fetch')));
    const user = await throughName(/Deliver with Swift/);
    expect((await screen.findByRole('alert')).textContent).toMatch(/Couldn’t load your weekly fee/);
    await user.click(screen.getByRole('checkbox', { name: /I agree to the Driver Partner Agreement/ }));
    expect(button('Create rider account').disabled).toBe(true);
    await user.click(button('Try again'));
    expect((await feeBox()).checked).toBe(false);
    expect(screen.getByRole('region', { name: 'Your weekly fee' }).textContent).toContain('$6,000/week');
  });

  it('no fee for the choice keeps the button waiting', async () => {
    fx.fetch.mockImplementation(() => served({ ...SIGNUP_PRICING, movers: [] }));
    const first = await throughName(/Deliver with Swift/);
    expect((await screen.findByText('No weekly fee is set for this choice yet.'))).toBeTruthy();
    await first.click(screen.getByRole('checkbox', { name: /I agree to the Driver Partner Agreement/ }));
    expect(button('Create rider account').disabled).toBe(true);
  });

  it('words that are not the words are refused, never ticked', async () => {
    fx.fetch.mockImplementation(() => served({ ...SIGNUP_PRICING, feeTerms: { version: 'v1', items: [], tick: '' } }));
    const user = await throughName(/Deliver with Swift/);
    expect((await screen.findByText('Couldn’t load the weekly fee terms — try again later.'))).toBeTruthy();
    expect(screen.queryByRole('checkbox', { name: /weekly fee/ })).toBeNull();
    await user.click(screen.getByRole('checkbox', { name: /I agree to the Driver Partner Agreement/ }));
    expect(button('Create rider account').disabled).toBe(true);
  });

  it('an API older than the tick (an amount, no words): the amount is shown, nothing is ticked or sent', async () => {
    fx.fetch.mockImplementation(() => served({ ...SIGNUP_PRICING, feeTerms: undefined }));
    const user = await throughName(/Deliver with Swift/);
    expect((await screen.findByRole('region', { name: 'Your weekly fee' })).textContent).toContain('$6,000/week');
    expect(screen.queryByRole('checkbox', { name: /weekly fee/ })).toBeNull();
    await user.click(screen.getByRole('checkbox', { name: /I agree to the Driver Partner Agreement/ }));
    await user.click(button('Create rider account'));
    expect(fx.become.mock.calls[0]![0]).toEqual({ role: 'MOVER', acceptAgreement: true, vehicleType: 'MOTORCYCLE' });
  });

  it('the server refusing the tick because the fee changed: its words are shown, the price is read again, the tick is cleared', async () => {
    const user = await throughName(/Deliver with Swift/);
    await user.click(await feeBox());
    await user.click(screen.getByRole('checkbox', { name: /I agree to the Driver Partner Agreement/ }));
    const changed = Object.assign(new Error('The weekly fee is now $6,500 a week. Check it and tick “I understand the weekly fee” again.'), { code: 'WEEKLY_FEE_CHANGED' });
    fx.become.mockRejectedValueOnce(changed);
    fx.fetch.mockImplementation(() => served({ ...SIGNUP_PRICING, movers: [{ vehicleType: 'MOTORCYCLE', rate: 6500 }, { vehicleType: 'BICYCLE', rate: 5000 }] }));
    await user.click(button('Create rider account'));
    expect((await screen.findByText(/The weekly fee is now \$6,500 a week/)).getAttribute('role')).toBe('alert');
    await waitFor(() => expect(screen.getByRole('region', { name: 'Your weekly fee' }).textContent).toContain('$6,500/week'));
    expect((await feeBox()).checked).toBe(false);
    expect(fx.replace).not.toHaveBeenCalled();
  });
});
