import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import SignupPage from './page';
import LoginPage from '../login/page';
import { CODE_NOT_SEEN_HINT, fullPhone } from '@/components/auth-ui';
import { guyanaLocal, guyanaPhone, guyanaPhoneProblem, guyanaPhoneReady } from '@/lib/guyana-phone';
import { NUMBER_LOOKS_WRONG, otpSendRefusal } from '@/lib/otp-send-refusal';

// [SIGNUP-PHONE · owner 1 Nov 2026] The sign-up phone box pre-filled "+592" as free text: people deleted it, doubled
// it or added a trunk 0, the server refused the first try (400) or the SMS provider refused the number, and the code
// came only on a second attempt. Sign-up now works like sign-in and the app: a fixed +592 chip, the local number in
// the box, every normal way of typing it sent as +592 and seven digits on the FIRST try, and every refusal in words.

const mocked = vi.hoisted(() => ({
  sendOtp: vi.fn(),
  verifyOtp: vi.fn(),
  registerAccount: vi.fn(),
  becomePartner: vi.fn(),
  verifyPartnerLogin: vi.fn(),
  sessionProbe: vi.fn(),
  restoreSession: vi.fn(),
  logout: vi.fn(),
  docs: vi.fn(),
  replace: vi.fn(),
  push: vi.fn(),
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: mocked.replace, push: mocked.push }),
  useSearchParams: () => new URLSearchParams(''),
}));
vi.mock('@/lib/auth', () => ({ sendOtp: mocked.sendOtp, verifyPartnerLogin: mocked.verifyPartnerLogin, sessionProbe: mocked.sessionProbe, restoreSession: mocked.restoreSession, logout: mocked.logout }));
beforeEach(() => {
  mocked.sessionProbe.mockReset();
  mocked.sessionProbe.mockResolvedValue({ ok: false });
  mocked.docs.mockReset();
  mocked.docs.mockResolvedValue({ checklist: [], documents: [], missing: [], roleVerified: true });
  mocked.restoreSession.mockReset();
  mocked.restoreSession.mockResolvedValue({ ok: false });
  mocked.logout.mockReset();
  mocked.logout.mockResolvedValue(undefined);
  mocked.replace.mockReset();
});
vi.mock('@/lib/customer-account', () => ({ verifyOtp: mocked.verifyOtp, registerAccount: mocked.registerAccount, becomePartner: mocked.becomePartner }));
vi.mock('@/lib/geolocate', () => ({ currentCoords: vi.fn() }));
vi.mock('@/lib/mover-api', () => ({ getVerificationStatus: mocked.docs }));

const FORMS = ['6001234', '600 1234', '600-1234', '0600 1234', '0600-1234', '+592 600 1234', '+5926001234', '592 600 1234', '5926001234', '(592) 600-1234', '00592 600 1234', '+592 0600 1234'];

describe('every normal way of typing a Guyana number is +592 and seven digits', () => {
  it.each(FORMS)('%s', (typed) => {
    expect(guyanaLocal(typed)).toBe('6001234');
    expect(guyanaPhone(typed)).toBe('+5926001234');
    expect(guyanaPhoneReady(typed)).toBe(true);
    expect(guyanaPhoneProblem(typed)).toBeNull();
  });

  it('a 7xx number is a normal Guyana number too', () => {
    expect(guyanaPhone('712 3456')).toBe('+5927123456');
    expect(guyanaPhoneReady('712 3456')).toBe(true);
  });

  it('says what is wrong before anything is sent', () => {
    expect(guyanaPhoneProblem('')).toBeNull();
    expect(guyanaPhoneReady('600 123')).toBe(false);
    expect(guyanaPhoneProblem('500 1234')).toBe('Guyana mobile numbers start with 6 or 7.');
    expect(guyanaPhoneReady('500 1234')).toBe(false);
    expect(guyanaPhoneProblem('600 12345')).toMatch(/7-digit number after \+592/);
    expect(guyanaPhoneReady('600 12345')).toBe(false);
  });
});

describe('a refused send is said in words, never silence or a generic failure', () => {
  it('a refused number (400) and a number the SMS provider refused (502) ask for the number again', () => {
    expect(otpSendRefusal(400, { error: { code: 'VALIDATION_ERROR', message: 'Invalid request data' } })).toBe(NUMBER_LOOKS_WRONG);
    expect(otpSendRefusal(400, { error: { code: 'COUNTRY_NOT_ACTIVE', message: 'Swift is currently available in Guyana only' } })).toBe(NUMBER_LOOKS_WRONG);
    expect(otpSendRefusal(502, { error: { code: 'SMS_SEND_FAILED', message: "We couldn't send your code right now." } })).toBe(NUMBER_LOOKS_WRONG);
    expect(NUMBER_LOOKS_WRONG).toBe("That number doesn't look right: enter the 7-digit number after +592.");
  });

  it('a throttle says how long to wait', () => {
    expect(otpSendRefusal(429, { error: { code: 'RATE_LIMITED', message: 'x', details: { retryAfterSeconds: 150, codeAlreadySent: false } } })).toBe('Too many tries; wait 3 minutes.');
    expect(otpSendRefusal(429, { error: { message: 'Too many codes requested for this number. Try again in 42 minutes.' } })).toBe('Too many tries; wait 42 minutes.');
    expect(otpSendRefusal(429, {}, '60')).toBe('Too many tries; wait 1 minute.');
    expect(otpSendRefusal(429, { error: { details: { retryAfterSeconds: 40, codeAlreadySent: true } } })).toBe('We already sent a code to this number. Wait 40 seconds to ask for a new one.');
    expect(otpSendRefusal(429, null)).toMatch(/^Too many tries; wait a few minutes/);
  });
});

describe('the site’s sendOtp shows the refusal words', () => {
  afterEach(() => { vi.unstubAllGlobals(); });
  it('a 400 from send-otp reads as the number looking wrong', async () => {
    const { sendOtp } = await vi.importActual<typeof import('@/lib/auth')>('@/lib/auth');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Invalid request data' } }), { status: 400 })));
    await expect(sendOtp('+5926001234')).rejects.toThrow(NUMBER_LOOKS_WRONG);
  });
  it('no connection is said too', async () => {
    const { sendOtp } = await vi.importActual<typeof import('@/lib/auth')>('@/lib/auth');
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    await expect(sendOtp('+5926001234')).rejects.toThrow('Could not send the code. Check your connection and try again.');
  });
});

describe('the sign-up phone step', () => {
  beforeEach(() => {
    mocked.sendOtp.mockReset();
    mocked.sendOtp.mockResolvedValue(undefined);
  });

  async function phoneStep() {
    render(<SignupPage />);
    fireEvent.click(screen.getByRole('button', { name: /Order on Swift/i }));
    return screen.getByLabelText('Phone number') as HTMLInputElement;
  }

  it('shows a fixed +592 chip and an empty box for the local number', async () => {
    const box = await phoneStep();
    expect(box.value).toBe('');
    expect(screen.getByText('+592')).toBeTruthy();
  });

  it.each(FORMS)('sends %s as +592 and seven digits on the first try', async (typed) => {
    const box = await phoneStep();
    fireEvent.change(box, { target: { value: typed } });
    fireEvent.click(screen.getByRole('button', { name: 'Send code' }));
    await waitFor(() => expect(mocked.sendOtp).toHaveBeenCalledTimes(1));
    expect(mocked.sendOtp).toHaveBeenCalledWith('+5926001234');
    expect(await screen.findByLabelText('Verification code')).toBeTruthy();
  });

  it('says what is wrong under the box and sends nothing', async () => {
    const box = await phoneStep();
    fireEvent.change(box, { target: { value: '500 1234' } });
    expect(screen.getByText('Guyana mobile numbers start with 6 or 7.')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Send code' }) as HTMLButtonElement).disabled).toBe(true);
    expect(mocked.sendOtp).not.toHaveBeenCalled();
  });

  it('shows the server’s refusal on screen', async () => {
    mocked.sendOtp.mockRejectedValue(new Error(NUMBER_LOOKS_WRONG));
    const box = await phoneStep();
    fireEvent.change(box, { target: { value: '600 1234' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send code' }));
    expect((await screen.findByRole('alert')).textContent).toContain(NUMBER_LOOKS_WRONG);
  });

  it('says where the code comes from under the code box', async () => {
    const box = await phoneStep();
    fireEvent.change(box, { target: { value: '600 1234' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send code' }));
    await screen.findByLabelText('Verification code');
    expect(screen.getByText(CODE_NOT_SEEN_HINT)).toBeTruthy();
    expect(CODE_NOT_SEEN_HINT).toBe("Can't see the code? It comes from 'Swift'. Check your Messages filters (Unknown Senders / Transactions) or spam folder.");
  });
});

describe('the sign-in code step says it too', () => {
  it('under the code box', async () => {
    mocked.sendOtp.mockResolvedValue(undefined);
    const user = userEvent.setup();
    render(<LoginPage />);
    await user.type(screen.getByLabelText('Phone number'), '600 1234');
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await screen.findByLabelText('Verification code');
    expect(screen.getByText(CODE_NOT_SEEN_HINT)).toBeTruthy();
  });
});

describe('sign-in normalises a Guyana number the same way, so an existing number is never "not found"', () => {
  it.each(FORMS)('%s', (typed) => {
    expect(fullPhone(typed)).toBe('+5926001234');
  });
});

describe('a browser already signed in is not asked for a code again', () => {
  it.each([
    [['VENDOR'], '/dashboard', 'Go to your dashboard'],
    [['MOVER'], '/portal', 'Go to your portal'],
    [['DRIVER'], '/portal', 'Go to your portal'],
    [['CUSTOMER'], '/', 'Go to Swift'],
  ])('sign-up, roles %j: straight on to %s', async (roles, home, label) => {
    mocked.sessionProbe.mockResolvedValue({ ok: true, user: { id: 'u1', phone: '+5926001234', roles } });
    render(<SignupPage />);
    expect(await screen.findByRole('heading', { name: 'You’re signed in as +592 6001234' })).toBeTruthy();
    expect(screen.getByRole('link', { name: label }).getAttribute('href')).toBe(home);
    expect(screen.queryByRole('button', { name: /Order on Swift/i })).toBeNull();
    expect(mocked.sendOtp).not.toHaveBeenCalled();
  });

  it('sign-in: the same card, no phone box', async () => {
    mocked.sessionProbe.mockResolvedValue({ ok: true, user: { id: 'u1', phone: '+5926001234', roles: ['VENDOR'] } });
    render(<LoginPage />);
    expect(await screen.findByRole('link', { name: 'Go to your dashboard' })).toBeTruthy();
    expect(screen.queryByLabelText('Phone number')).toBeNull();
  });

  it('"Use a different number" signs out first, then shows the form', async () => {
    mocked.sessionProbe.mockResolvedValue({ ok: true, user: { id: 'u1', phone: '+5926001234', roles: ['MOVER'] } });
    const user = userEvent.setup();
    render(<LoginPage />);
    await user.click(await screen.findByRole('button', { name: 'Use a different number' }));
    await user.click(screen.getByRole('button', { name: 'Sign out' }));
    await waitFor(() => expect(mocked.logout).toHaveBeenCalledTimes(1));
    expect(await screen.findByLabelText('Phone number')).toBeTruthy();
  });

  it('a rider who stopped before the documents were in resumes at Documents', async () => {
    mocked.sessionProbe.mockResolvedValue({ ok: true, user: { id: 'u1', phone: '+5926001234', roles: ['MOVER'] } });
    mocked.docs.mockResolvedValue({ checklist: ['national_id'], documents: [], missing: ['national_id'], roleVerified: false });
    render(<SignupPage />);
    expect((await screen.findByRole('link', { name: 'Go to your documents' })).getAttribute('href')).toBe('/portal/documents');
  });

  it('back after the 15-minute access cookie ran out: the refresh cookie restores it, still no code', async () => {
    mocked.restoreSession.mockResolvedValue({ ok: true, user: { id: 'u1', phone: '+5926001234', roles: ['VENDOR'] } });
    render(<SignupPage />);
    expect(await screen.findByRole('link', { name: 'Go to your dashboard' })).toBeTruthy();
    expect(mocked.restoreSession).toHaveBeenCalledTimes(1);
  });

  it('a server that could not say spends no refresh and shows the form', async () => {
    mocked.sessionProbe.mockResolvedValue({ ok: false, unreachable: true });
    render(<LoginPage />);
    await waitFor(() => expect(mocked.sessionProbe).toHaveBeenCalled());
    expect(mocked.restoreSession).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Phone number')).toBeTruthy();
  });

  it('signed out, or the server could not say: the form as always', async () => {
    mocked.sessionProbe.mockResolvedValue({ ok: false, unreachable: true });
    render(<LoginPage />);
    expect(screen.getByLabelText('Phone number')).toBeTruthy();
    await waitFor(() => expect(mocked.sessionProbe).toHaveBeenCalled());
    expect(screen.queryByText(/You’re signed in/)).toBeNull();
  });
});

describe('a wait is a countdown on the button, not an error box', () => {
  const wait = (codeAlreadySent: boolean) => Object.assign(new Error('x'), { status: 429, retryAfterSeconds: 35, codeAlreadySent });

  it('a code already on its way: the code box, a calm note, and "Send a new code in 35 s"', async () => {
    mocked.sendOtp.mockReset();
    mocked.sendOtp.mockRejectedValue(wait(true));
    render(<SignupPage />);
    fireEvent.click(screen.getByRole('button', { name: /Order on Swift/i }));
    fireEvent.change(screen.getByLabelText('Phone number'), { target: { value: '600 1234' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send code' }));
    expect(await screen.findByLabelText('Verification code')).toBeTruthy();
    expect(screen.getByRole('status').textContent).toBe('We already sent a code to this number. Enter it below.');
    expect((screen.getByRole('button', { name: 'Send a new code in 35 s' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('no code sent yet: the send button counts down, no error box', async () => {
    mocked.sendOtp.mockReset();
    mocked.sendOtp.mockRejectedValue(wait(false));
    const user = userEvent.setup();
    render(<LoginPage />);
    await user.type(screen.getByLabelText('Phone number'), '600 1234');
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByRole('button', { name: 'Send a new code in 35 s' })).toBeTruthy();
    expect(screen.queryByLabelText('Verification code')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('a cap without a wait the server can count is said in words', async () => {
    mocked.sendOtp.mockReset();
    mocked.sendOtp.mockRejectedValue(Object.assign(new Error('Too many tries; wait 42 minutes.'), { status: 429 }));
    const user = userEvent.setup();
    render(<LoginPage />);
    await user.type(screen.getByLabelText('Phone number'), '600 1234');
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Too many tries; wait 42 minutes.');
  });
});

describe('the site’s sendOtp passes the server’s wait along', () => {
  afterEach(() => { vi.unstubAllGlobals(); });
  it('429 with retryAfterSeconds and codeAlreadySent', async () => {
    const { sendOtp } = await vi.importActual<typeof import('@/lib/auth')>('@/lib/auth');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ success: false, error: { code: 'RATE_LIMITED', message: 'x', details: { retryAfterSeconds: 35, codeAlreadySent: true } } }), { status: 429 })));
    await expect(sendOtp('+5926001234')).rejects.toMatchObject({ status: 429, retryAfterSeconds: 35, codeAlreadySent: true });
  });
});

describe('[PERF] the "already signed in" card loads on demand on both pages', () => {
  it.each(['signup/page.tsx', 'login/page.tsx'])('%s imports it only as a type, through the loader', (file) => {
    const src = readFileSync(join(__dirname, '..', file), 'utf8');
    const imports = src.split('\n').filter((line) => /^import\s/.test(line));
    expect(imports.filter((line) => /signed-in-already'/.test(line) && !/^import type /.test(line))).toEqual([]);
    expect(imports).toContain("import { loadSignedIn } from '@/components/signed-in-loader';");
  });
});
