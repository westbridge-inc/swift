import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import SignupPage from './page';
import LoginPage from '../login/page';
import { SiteNav } from '@/components/site-nav';
import { CODE_NOT_RIGHT } from '@/lib/otp-send-refusal';

// [FLOW-QA 1-2 Nov 2026] Sign-in, sign-up and the public header, end to end: an account always lands in its own
// area, the header knows a signed-in partner, sign-up survives Back and refresh, another partner door adds to the
// account, and every refused code is said in plain words.

const mocked = vi.hoisted(() => ({
  query: '',
  sendOtp: vi.fn(),
  verifyOtp: vi.fn(),
  registerAccount: vi.fn(),
  becomePartner: vi.fn(),
  verifyPartnerLogin: vi.fn(),
  verifyCustomerLogin: vi.fn(),
  sessionProbe: vi.fn(),
  restoreSession: vi.fn(),
  logout: vi.fn(),
  pro: vi.fn(),
  replace: vi.fn(),
  push: vi.fn(),
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: mocked.replace, push: mocked.push }),
  useSearchParams: () => new URLSearchParams(mocked.query),
}));
vi.mock('@/lib/auth', () => ({ verifyPartnerLogin: mocked.verifyPartnerLogin, sessionProbe: mocked.sessionProbe, restoreSession: mocked.restoreSession, logout: mocked.logout, hasProviderProfile: mocked.pro }));
vi.mock('@/lib/otp-send', () => ({ sendOtp: mocked.sendOtp }));
vi.mock('@/lib/customer-login', () => ({ verifyCustomerLogin: mocked.verifyCustomerLogin }));
vi.mock('@/lib/customer-account', () => ({ verifyOtp: mocked.verifyOtp, registerAccount: mocked.registerAccount, becomePartner: mocked.becomePartner }));
vi.mock('@/lib/geolocate', () => ({ currentCoords: vi.fn() }));
vi.mock('@/lib/mover-api', () => ({ getVerificationStatus: vi.fn().mockResolvedValue({ missing: [], roleVerified: true }), getRiderProfile: vi.fn().mockResolvedValue({ id: 'r' }), getDriverProfile: vi.fn().mockResolvedValue(null) }));

beforeEach(() => {
  mocked.query = '';
  for (const f of [mocked.sendOtp, mocked.verifyOtp, mocked.verifyCustomerLogin, mocked.verifyPartnerLogin, mocked.sessionProbe, mocked.restoreSession, mocked.pro, mocked.replace, mocked.push]) f.mockReset();
  mocked.sendOtp.mockResolvedValue(undefined);
  mocked.sessionProbe.mockResolvedValue({ ok: false });
  mocked.restoreSession.mockResolvedValue({ ok: false });
  mocked.pro.mockResolvedValue(false);
  window.history.replaceState(null, '', '/');
});

async function loginWithCode(query: string) {
  mocked.query = query;
  const user = userEvent.setup();
  render(<LoginPage />);
  await user.type(screen.getByLabelText('Phone number'), '600 1234');
  await user.click(screen.getByRole('button', { name: 'Continue' }));
  await user.type(await screen.findByLabelText('Verification code', {}, { timeout: 5000 }), '246810');
  await user.click(screen.getByRole('button', { name: 'Verify' }));
}

describe('[FLOW-QA F1] "Sign in" from the header (next=/) lands each account in its own area', () => {
  it.each([
    [['VENDOR_OWNER', 'CUSTOMER'], false, '/dashboard'],
    [['MOVER', 'CUSTOMER'], false, '/portal'],
    [['CUSTOMER'], true, '/portal/weekly-fee'],
    [['CUSTOMER'], false, '/'],
  ])('roles %j (pro %s) -> %s', async (roles, pro, home) => {
    mocked.verifyCustomerLogin.mockResolvedValue({ user: { id: 'u1', roles } });
    mocked.pro.mockResolvedValue(pro);
    await loginWithCode('next=/');
    await waitFor(() => expect(mocked.replace).toHaveBeenCalledWith(home));
  });

  it('a customer deep link still comes back to that page', async () => {
    mocked.verifyCustomerLogin.mockResolvedValue({ user: { id: 'u1', roles: ['VENDOR_OWNER'] } });
    await loginWithCode(`next=${encodeURIComponent('/cart')}`);
    await waitFor(() => expect(mocked.replace).toHaveBeenCalledWith('/cart'));
  });
});

describe('[FLOW-QA F14] the signed-in card on /login?next=/ links where it says', () => {
  it('a business: "Go to your dashboard" -> /dashboard, not the launch page', async () => {
    mocked.query = 'next=/';
    mocked.sessionProbe.mockResolvedValue({ ok: true, user: { id: 'u1', phone: '+5926001234', roles: ['VENDOR_OWNER'] } });
    render(<LoginPage />);
    expect((await screen.findByRole('link', { name: 'Go to your dashboard' })).getAttribute('href')).toBe('/dashboard');
  });
});

describe('[FLOW-QA F5b] the public header knows a signed-in partner', () => {
  it.each([
    [['VENDOR_OWNER'], 'Dashboard', '/dashboard'],
    [['MOVER'], 'My portal', '/portal'],
  ])('roles %j: "%s" instead of Sign in / Join Swift', async (roles, label, href) => {
    localStorage.setItem('swift_signed_in_before', '1');
    mocked.sessionProbe.mockResolvedValue({ ok: true, user: { id: 'u1', roles } });
    render(<SiteNav />);
    const link = await screen.findByRole('link', { name: label });
    expect(link.getAttribute('href')).toBe(href);
    expect(screen.queryByRole('link', { name: 'Join Swift' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Sign in' })).toBeNull();
  });

  it('a guest browser asks nothing and keeps Sign in / Join Swift', async () => {
    render(<SiteNav />);
    expect(screen.getByRole('link', { name: 'Join Swift' })).toBeTruthy();
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    expect(mocked.sessionProbe).not.toHaveBeenCalled();
  });
});

async function toCodeStep(door: RegExp) {
  render(<SignupPage />);
  fireEvent.click(await screen.findByRole('button', { name: door }));
  fireEvent.change(screen.getByLabelText('Phone number'), { target: { value: '600 1234' } });
  fireEvent.click(screen.getByRole('button', { name: 'Send code' }));
  return screen.findByLabelText('Verification code');
}

describe('[FLOW-QA F6] sign-up survives Back and refresh', () => {
  it('each step is its own address, and a refresh comes back to it with what was typed', async () => {
    window.history.replaceState(null, '', '/signup');
    await toCodeStep(/Put my business on Swift|business/i);
    expect(new URLSearchParams(window.location.search).get('step')).toBe('code');
    // a refresh: the page starts again at the same address
    const { unmount } = { unmount: () => document.body.replaceChildren() };
    unmount();
    render(<SignupPage />);
    expect(await screen.findByLabelText('Verification code')).toBeTruthy();
    expect(screen.getByText('Enter the code sent to +592 600 1234.')).toBeTruthy();
  });

  it('the phone’s Back goes to the step before, with the number still there', async () => {
    window.history.replaceState(null, '', '/signup');
    await toCodeStep(/business/i);
    act(() => {
      window.history.replaceState(null, '', '/signup?step=phone');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    expect(((await screen.findByLabelText('Phone number')) as HTMLInputElement).value).toBe('600 1234');
  });

  it('an old step address with nothing kept starts at the beginning', async () => {
    window.history.replaceState(null, '', '/signup?step=name');
    render(<SignupPage />);
    expect(await screen.findByRole('heading', { name: 'Who are you signing up as?' })).toBeTruthy();
  });
});

describe('[FLOW-QA F9] an existing account choosing another partner door adds to its account', () => {
  it('a rider tapping the business door goes on to the business step', async () => {
    window.history.replaceState(null, '', '/signup');
    mocked.verifyOtp.mockResolvedValue({ isNewUser: false, signedIn: true, user: { id: 'u1', roles: ['MOVER', 'CUSTOMER'] } });
    fireEvent.change(await toCodeStep(/business/i), { target: { value: '246810' } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByText('Add a business to your Swift account.')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Your business' })).toBeTruthy();
    expect(mocked.replace).not.toHaveBeenCalled();
  });

  it('a business tapping the rider door goes on to the vehicle step', async () => {
    window.history.replaceState(null, '', '/signup');
    mocked.verifyOtp.mockResolvedValue({ isNewUser: false, signedIn: true, user: { id: 'u1', roles: ['VENDOR_OWNER'] } });
    fireEvent.change(await toCodeStep(/Deliver with Swift/), { target: { value: '246810' } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByText('Add your vehicle to your Swift account.')).toBeTruthy();
  });

  it('the same door it already has goes home', async () => {
    window.history.replaceState(null, '', '/signup');
    mocked.verifyOtp.mockResolvedValue({ isNewUser: false, signedIn: true, user: { id: 'u1', roles: ['VENDOR_OWNER'] } });
    fireEvent.change(await toCodeStep(/business/i), { target: { value: '246810' } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await waitFor(() => expect(mocked.replace).toHaveBeenCalledWith('/dashboard'));
  });
});

describe('[FLOW-QA F16] a refused code in plain words', () => {
  it('sign-up: a wrong or expired code', async () => {
    window.history.replaceState(null, '', '/signup');
    mocked.verifyOtp.mockRejectedValue(Object.assign(new Error('Invalid OTP code'), { status: 400, code: 'INVALID_OTP' }));
    fireEvent.change(await toCodeStep(/business/i), { target: { value: '246810' } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect((await screen.findByRole('alert')).textContent).toBe(CODE_NOT_RIGHT);
  });

  it('sign-in: too many tries says how long', async () => {
    mocked.verifyPartnerLogin.mockRejectedValue(Object.assign(new Error('Rate limit exceeded'), { status: 429, retryAfterSeconds: 30 }));
    await loginWithCode('');
    expect((await screen.findByRole('alert')).textContent).toContain('Too many tries; wait 30 seconds.');
  });
});

describe('[FLOW-QA F23] the code step shows the number grouped', () => {
  it('sign-in: "Sent to +592 600 1234"', async () => {
    const user = userEvent.setup();
    render(<LoginPage />);
    await user.type(screen.getByLabelText('Phone number'), '6001234');
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await screen.findByLabelText('Verification code', {}, { timeout: 5000 });
    expect(screen.getByText(/Sent to \+592 600 1234/)).toBeTruthy();
  });
});

describe('[REVIEW-GMF2 S3-1] a partner page’s sign-up (?as=…) resumes its step after a refresh', () => {
  it('rider door, refreshed at the code step: still the code step, door and number kept', async () => {
    window.history.replaceState(null, '', '/signup?as=rider');
    render(<SignupPage />);
    fireEvent.change(await screen.findByLabelText('Phone number'), { target: { value: '600 1234' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send code' }));
    await screen.findByLabelText('Verification code');
    expect(new URLSearchParams(window.location.search).get('step')).toBe('code');
    expect(new URLSearchParams(window.location.search).get('as')).toBe('rider');
    document.body.replaceChildren();
    render(<SignupPage />);
    expect(await screen.findByLabelText('Verification code')).toBeTruthy();
    expect(new URLSearchParams(window.location.search).get('step')).toBe('code');
    expect(JSON.parse(sessionStorage.getItem('swift_signup_draft')!)).toMatchObject({ step: 'code', role: 'RIDER', phone: '600 1234' });
  });
});

describe('[REVIEW-GMF2 S3-2] a locked or expired code says to send a new one', () => {
  it.each([
    ['Too many attempts. Request a new OTP.', 'Too many tries for this code. Send a new code.'],
    ['OTP expired or not found. Request a new one.', 'That code has expired. Send a new code.'],
    ['Invalid OTP code', CODE_NOT_RIGHT],
  ])('server "%s" -> "%s"', async (server, words) => {
    window.history.replaceState(null, '', '/signup');
    mocked.verifyOtp.mockRejectedValue(Object.assign(new Error(server), { status: 400, code: 'INVALID_OTP' }));
    fireEvent.change(await toCodeStep(/business/i), { target: { value: '246810' } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect((await screen.findByRole('alert')).textContent).toBe(words);
  });
});

describe('[REVIEW-GMF2 S3-3] once the account exists, Back leaves sign-up instead of reopening its steps', () => {
  it('at the business step, Back to an earlier step goes on back (never a re-push), and the business step stays', async () => {
    window.history.replaceState(null, '', '/signup');
    mocked.verifyOtp.mockResolvedValue({ isNewUser: false, signedIn: true, user: { id: 'u1', roles: ['MOVER'] } });
    fireEvent.change(await toCodeStep(/business/i), { target: { value: '246810' } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await screen.findByText('Add a business to your Swift account.');
    const back = vi.spyOn(window.history, 'back').mockImplementation(() => {});
    const push = vi.spyOn(window.history, 'pushState');
    act(() => {
      window.history.replaceState(null, '', '/signup?step=code');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    expect(back).toHaveBeenCalledTimes(1);
    expect(push).not.toHaveBeenCalled();
    expect(screen.getByRole('heading', { name: 'Your business' })).toBeTruthy();
    back.mockRestore(); push.mockRestore();
  });
});

describe('[REVIEW-GMF2 S4-11] finishing sign-up clears the kept draft', () => {
  it('an existing account that goes home leaves nothing kept for the tab', async () => {
    window.history.replaceState(null, '', '/signup');
    mocked.verifyOtp.mockResolvedValue({ isNewUser: false, signedIn: true, user: { id: 'u1', roles: ['VENDOR_OWNER'] } });
    fireEvent.change(await toCodeStep(/business/i), { target: { value: '246810' } });
    expect(sessionStorage.getItem('swift_signup_draft')).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await waitFor(() => expect(mocked.replace).toHaveBeenCalledWith('/dashboard'));
    expect(sessionStorage.getItem('swift_signup_draft')).toBeNull();
  });

  it('[REVIEW-GMF2 S4] a self-employed pro choosing a door they have no role for... the customer door goes to their weekly fee', async () => {
    window.history.replaceState(null, '', '/signup');
    mocked.pro.mockResolvedValue(true);
    mocked.verifyOtp.mockResolvedValue({ isNewUser: false, signedIn: true, user: { id: 'u1', roles: ['CUSTOMER'] } });
    fireEvent.change(await toCodeStep(/Order on Swift/), { target: { value: '246810' } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await waitFor(() => expect(mocked.replace).toHaveBeenCalledWith('/portal/weekly-fee'));
  });
});

describe('[REVIEW-GMF2 S3-4] sign-in returns a partner to the private page that sent them, inside their own area only', () => {
  it.each([
    [{ home: '/dashboard' }, '/dashboard/orders?page=2', '/dashboard/orders?page=2'],
    [{ home: '/portal' }, '/portal/documents', '/portal/documents'],
    [{ home: '/portal' }, '/dashboard/orders', '/portal'],
    [{ home: '/dashboard' }, '/dashboardx', '/dashboard'],
    [{ home: '/dashboard' }, '//evil.example/dashboard', '/dashboard'],
  ])('%j with next=%s -> %s', async (answer, next, lands) => {
    mocked.verifyPartnerLogin.mockResolvedValue({ user: { id: 'p1' }, ...answer });
    await loginWithCode(`next=${encodeURIComponent(next)}`);
    await waitFor(() => expect(mocked.replace).toHaveBeenCalledWith(lands));
  });
});
