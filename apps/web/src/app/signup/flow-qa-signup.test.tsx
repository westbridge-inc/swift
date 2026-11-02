import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import SignupPage from './page';

// ---------------------------------------------------------------------------
// [WEB-ONBOARDING · FLOW-QA 1-2 Nov 2026] The sign-up findings:
//  - F19: an own-name store could press Create business without signing the declaration (then an error box). The
//    button now waits for the tick and the line under it says so, in the app's words; the server's refusal of a name
//    that is not the owner's own surname says what to do next.
//  - F26: a Services business was asked to "Place your store on the map". It is asked where it is based.
//  - F28: the closed "Order on Swift" door was a dead button; it links to the launching-soon page.
//  - F25: /signup has its own title; F24: its ticks and small links are 44 px tall to tap.
// ---------------------------------------------------------------------------

const fx = vi.hoisted(() => ({ become: vi.fn(), sign: vi.fn(), replace: vi.fn(), probe: vi.fn(), search: vi.fn(), api: vi.fn(), open: { v: false } }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: fx.replace }) }));
vi.mock('@/lib/auth', () => ({ sendOtp: vi.fn(), sessionProbe: fx.probe, apiFetch: fx.api }));
vi.mock('@/lib/otp-send', () => ({ sendOtp: vi.fn() }));
vi.mock('@/lib/customer-account', () => ({ verifyOtp: vi.fn(), registerAccount: vi.fn(), becomePartner: fx.become, signOwnName: fx.sign }));
vi.mock('@/lib/customer-places', () => ({ placesAutocomplete: fx.search, placeDetails: vi.fn() }));
vi.mock('@/lib/geolocate', () => ({ currentCoords: vi.fn() }));
vi.mock('./weekly-fee-loader', () => ({ loadWeeklyFee: () => import('@/test/weekly-fee-fixture') }));
vi.mock('@/lib/use-web-ordering', () => ({ useWebOrderingOpen: () => fx.open.v, useWebOrderingSoon: () => !fx.open.v }));

const DOOR = { placeId: 'door', primary: '12 Regent Street', secondary: 'Georgetown', lat: 6.812, lng: -58.163 };
const loadMap = () => screen.getByRole('application').querySelectorAll('img').forEach((tile) => fireEvent.load(tile));
const ask = () => document.querySelector('[data-signup-ask]')?.textContent ?? null;

beforeEach(() => {
  vi.resetAllMocks();
  fx.open.v = false;
  fx.become.mockResolvedValue({});
  fx.sign.mockResolvedValue({});
  fx.probe.mockResolvedValue({ ok: true, user: { id: 'u1', phone: '+5926001008' } });
  fx.search.mockResolvedValue([DOOR]);
  fx.api.mockResolvedValue({ data: { address: 'Store entrance, Georgetown' } });
  window.history.replaceState(null, '', '/signup?resume=business');
});

async function businessStep(name: string, vendorType = 'RESTAURANT') {
  const user = userEvent.setup();
  render(<SignupPage />);
  await screen.findByRole('heading', { name: 'Your business' });
  fireEvent.change(screen.getByLabelText('Business name'), { target: { value: name } });
  fireEvent.change(screen.getByLabelText('Business type'), { target: { value: vendorType } });
  fireEvent.change(screen.getByLabelText('Street address'), { target: { value: '12 Regent Street' } });
  fireEvent.change(screen.getByLabelText('City or town'), { target: { value: 'Georgetown' } });
  return user;
}

async function placePin(user: ReturnType<typeof userEvent.setup>, button: RegExp, confirm = 'Confirm store location', check?: () => void) {
  await user.click(screen.getByRole('button', { name: button }));
  await screen.findByRole('button', { name: /12 Regent Street.*Georgetown/ });
  loadMap();
  await user.click(screen.getByRole('button', { name: /12 Regent Street.*Georgetown/ }));
  loadMap();
  check?.();
  await user.click(screen.getByRole('button', { name: confirm }));
}

describe('[F19] the own-name declaration is part of what is missing', () => {
  it('own name chosen, not signed: the button waits and says so; signed: it goes', async () => {
    const user = await businessStep('Persaud');
    await placePin(user, /Place your store on the map/);
    await user.click(await screen.findByRole('radio', { name: /My own name — just my surname/ }));
    await user.click(screen.getByRole('checkbox', { name: /I agree to the Business Agreement/ }));
    const create = screen.getByRole('button', { name: 'Create business' }) as HTMLButtonElement;
    expect(create.disabled).toBe(true);
    expect(ask()).toBe('Sign the own-name declaration');
    await user.click(screen.getByRole('checkbox', { name: 'I have read the declaration above and I sign it.' }));
    expect(create.disabled).toBe(false);
    expect(ask()).toBeNull();
  });

  it('a name the server finds is not the owner’s own: its words, then what to do next', async () => {
    fx.become.mockRejectedValue(Object.assign(new Error('“Sample Shop” is not just your surname with your first names or initials, so the law asks you to register it as a business name.'), { code: 'OWN_NAME_MISMATCH' }));
    const user = await businessStep('Sample Shop');
    await placePin(user, /Place your store on the map/);
    await user.click(await screen.findByRole('radio', { name: /My own name — just my surname/ }));
    await user.click(screen.getByRole('checkbox', { name: 'I have read the declaration above and I sign it.' }));
    await user.click(screen.getByRole('checkbox', { name: /I agree to the Business Agreement/ }));
    await user.click(screen.getByRole('button', { name: 'Create business' }));
    const alert = (await screen.findByRole('alert')).textContent!;
    expect(alert).toContain('is not just your surname');
    expect(alert).toContain('Choose “A business name, or a company” and add your business registration under Documents, or use just your surname as the store name.');
  });
});

describe('[F26] a Services business is asked where it is based', () => {
  it('the map button, the line under the button and the confirmation say “where you’re based”', async () => {
    const user = await businessStep('Test services', 'SERVICE');
    expect(screen.queryByRole('button', { name: 'Place your store on the map' })).toBeNull();
    expect(ask()).toBe('Show where you’re based on the map');
    await placePin(user, /Show where you’re based on the map/, 'Confirm location', () => {
      // [FLOW-QA2 F26] the map itself says it too: never a store, its entrance or "Confirm store location"
      const picker = screen.getByRole('heading', { name: 'Show where you’re based on the map' }).closest('section')!;
      expect(picker.textContent).toContain('Put the pin where you’re based.');
      expect(picker.textContent).not.toMatch(/store/i);
      expect(picker.textContent).not.toMatch(/entrance/i);
      expect(screen.getByRole('application', { name: 'Location map' })).toBeTruthy();
    });
    expect(await screen.findByText(/^Location confirmed:/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Move the pin' })).toBeTruthy();
  });

  it('a shop keeps the store words on the map', async () => {
    const user = await businessStep('Test shop', 'STORE');
    await placePin(user, /Place your store on the map/, 'Confirm store location', () => {
      const picker = screen.getByRole('heading', { name: 'Place your store on the map' }).closest('section')!;
      expect(picker.textContent).toContain('Put the pin on your store’s entrance.');
      expect(picker.textContent).toContain('Riders and customers will come here.');
    });
    expect(await screen.findByText(/^Store location confirmed:/)).toBeTruthy();
  });
});

describe('[FLOW-QA2 F24] the own-name tick is the same size as the other ticks', () => {
  it('a 20 px box in a 44 px row: the same tick row as the Business Agreement', async () => {
    const user = await businessStep('Persaud');
    await user.click(await screen.findByRole('radio', { name: /My own name — just my surname/ }));
    const own = screen.getByRole('checkbox', { name: 'I have read the declaration above and I sign it.' }).closest('label')!;
    const agreement = screen.getByRole('checkbox', { name: /I agree to the Business Agreement/ }).closest('label')!;
    expect(own.className).toBeTruthy();
    expect(own.className).toBe(agreement.className);
    expect(own.getAttribute('style')).toBe(agreement.getAttribute('style'));
    const css = readFileSync(join(__dirname, '..', 'auth-flow.module.css'), 'utf8');
    expect(css).toMatch(/\.legal input\[type='checkbox'\] \{ width: 20px; height: 20px;/);
  });
});

describe('[FLOW-QA2 NEW-6] a refresh on the business step keeps what was typed', () => {
  it('[REVIEW-F3 S4-2] a finished business sign-up clears what the tab kept, so the next business step starts empty', async () => {
    const user = await businessStep('Finished Kitchen');
    await placePin(user, /Place your store on the map/);
    await user.click(screen.getByRole('checkbox', { name: /I agree to the Business Agreement/ }));
    await waitFor(() => expect(sessionStorage.getItem('swift_signup_business')).toContain('Finished Kitchen'));
    await user.click(screen.getByRole('button', { name: 'Create business' }));
    await waitFor(() => expect(fx.replace).toHaveBeenCalledWith('/dashboard'));
    expect(sessionStorage.getItem('swift_signup_business')).toBeNull();
    expect(sessionStorage.getItem('swift_signup_draft')).toBeNull();
  });

  it('the name, type and address come back after a refresh; the ticks do not', async () => {
    const user = await businessStep('Refresh Kitchen', 'SUPERMARKET');
    fireEvent.change(screen.getByLabelText('Region (optional)'), { target: { value: 'Demerara-Mahaica' } });
    await user.click(await screen.findByRole('radio', { name: /My own name — just my surname/ }));
    await user.click(screen.getByRole('checkbox', { name: 'I have read the declaration above and I sign it.' }));
    await waitFor(() => expect(window.location.search).toContain('step=business'));
    cleanup();
    // the browser reloads the same address: the page mounts again from what this tab kept
    render(<SignupPage />);
    await screen.findByRole('heading', { name: 'Your business' });
    expect((screen.getByLabelText('Business name') as HTMLInputElement).value).toBe('Refresh Kitchen');
    expect((screen.getByLabelText('Business type') as HTMLSelectElement).value).toBe('SUPERMARKET');
    expect((screen.getByLabelText('Street address') as HTMLInputElement).value).toBe('12 Regent Street');
    expect((screen.getByLabelText('City or town') as HTMLInputElement).value).toBe('Georgetown');
    expect((screen.getByLabelText('Region (optional)') as HTMLInputElement).value).toBe('Demerara-Mahaica');
    expect(((await screen.findByRole('radio', { name: /My own name — just my surname/ })) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByRole('checkbox', { name: 'I have read the declaration above and I sign it.' }) as HTMLInputElement).checked).toBe(false);
    expect((screen.getByRole('checkbox', { name: /I agree to the Business Agreement/ }) as HTMLInputElement).checked).toBe(false);
    sessionStorage.clear();
  });
});

describe('[F28] the closed ordering door links to the launching-soon page', () => {
  it('before launch: a link, not a dead button', async () => {
    window.history.replaceState(null, '', '/signup');
    fx.probe.mockResolvedValue({ ok: false });
    render(<SignupPage />);
    const door = await screen.findByRole('link', { name: /Order on Swift/ });
    expect(door.getAttribute('href')).toBe('/launching-soon');
    await waitFor(() => expect(screen.queryByRole('button', { name: /Order on Swift/ })).toBeNull());
  });
});

describe('[F25 · F24] the page’s title, and ticks and links big enough to tap', () => {
  it('its own title', () => {
    const layout = readFileSync(join(__dirname, 'layout.tsx'), 'utf8');
    expect(layout).toContain("title: 'Sign up'");
    expect(layout).not.toMatch(/robots/);
  });
  it('44 px rows for the ticks and the small links', () => {
    const css = readFileSync(join(__dirname, '..', 'auth-flow.module.css'), 'utf8');
    expect(css).toMatch(/\.legal \{[^}]*min-height: 44px/);
    expect(css).toMatch(/\.inlineLink \{[^}]*padding-block: 13px/);
  });
});
