import { afterEach, describe, expect, it, vi } from 'vitest';
import { NUMBER_LOOKS_WRONG } from './otp-send-refusal';

// [SIGNUP-PHONE] The site's code request (lib/otp-send, used by sign-in and sign-up only) says every refusal in words.
describe('the site’s sendOtp shows the refusal words', () => {
  afterEach(() => { vi.unstubAllGlobals(); });
  it('a 400 from send-otp reads as the number looking wrong', async () => {
    const { sendOtp } = await import('./otp-send');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Invalid request data' } }), { status: 400 })));
    await expect(sendOtp('+5926001234')).rejects.toThrow(NUMBER_LOOKS_WRONG);
  });
  it('no connection is said too', async () => {
    const { sendOtp } = await import('./otp-send');
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    await expect(sendOtp('+5926001234')).rejects.toThrow('Could not send the code. Check your connection and try again.');
  });
});

describe('the site’s sendOtp passes the server’s wait along', () => {
  afterEach(() => { vi.unstubAllGlobals(); });
  it('429 with retryAfterSeconds and codeAlreadySent', async () => {
    const { sendOtp } = await import('./otp-send');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ success: false, error: { code: 'RATE_LIMITED', message: 'x', details: { retryAfterSeconds: 35, codeAlreadySent: true } } }), { status: 429 })));
    await expect(sendOtp('+5926001234')).rejects.toMatchObject({ status: 429, retryAfterSeconds: 35, codeAlreadySent: true });
  });
});
