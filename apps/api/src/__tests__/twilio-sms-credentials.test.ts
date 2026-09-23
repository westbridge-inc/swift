import { afterEach, describe, expect, it, vi } from 'vitest';
import { getChannels } from '../providers/notifications/channels';

const accountSid = `AC${'a'.repeat(32)}`;
const keySid = `SK${'b'.repeat(32)}`;
const paddedTwilioIdentities = ([
  ['TWILIO_ACCOUNT_SID', accountSid],
  ['TWILIO_API_KEY_SID', keySid],
  ['TWILIO_FROM', '+15550000000'],
] as const).flatMap(([name, valid]) => [' ', '\t', '\r', '\n'].flatMap((whitespace) => [
  { name, value: `${whitespace}${valid}`, position: 'leading', whitespace: JSON.stringify(whitespace) },
  { name, value: `${valid}${whitespace}`, position: 'trailing', whitespace: JSON.stringify(whitespace) },
]));

function configure() {
  vi.stubEnv('NOTIFICATION_PROVIDER', 'twilio');
  vi.stubEnv('TWILIO_ACCOUNT_SID', accountSid);
  vi.stubEnv('TWILIO_API_KEY_SID', keySid);
  vi.stubEnv('TWILIO_API_KEY_SECRET', 'test-key-secret');
  vi.stubEnv('TWILIO_AUTH_TOKEN', 'legacy-master-token');
  vi.stubEnv('TWILIO_FROM', '+15550000000');
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('Twilio outbound SMS credentials and error boundary', () => {
  it('does not require Twilio secrets when the dev SMS adapter is selected', () => {
    vi.stubEnv('NOTIFICATION_PROVIDER', 'dev');
    vi.stubEnv('PUSH_PROVIDER', 'expo');
    vi.stubEnv('TWILIO_ACCOUNT_SID', '');
    vi.stubEnv('TWILIO_API_KEY_SID', '');
    vi.stubEnv('TWILIO_API_KEY_SECRET', '');
    vi.stubEnv('TWILIO_FROM', '');
    expect(() => getChannels()).not.toThrow();
  });

  it('uses the revocable API key for Basic auth and the account SID for the Messages path', async () => {
    configure();
    const messageSid = `SM${'0'.repeat(32)}`;
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ sid: messageSid }), { status: 201 }));
    vi.stubGlobal('fetch', fetchMock);

    expect(await getChannels().sms.sendSms('+5926000000', 'test body')).toEqual({ ref: messageSid });
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, { headers: Record<string, string>; body: string; signal: AbortSignal }];
    expect(url).toBe(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`);
    expect(init.headers['Authorization'])
      .toBe(`Basic ${Buffer.from(`${keySid}:test-key-secret`).toString('base64')}`);
    expect(init.headers['Authorization']).not.toContain('legacy-master-token');
    expect(new URLSearchParams(init.body).get('Body')).toBe('test body');
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('refuses legacy Auth Token as an outbound credential', () => {
    configure();
    delete process.env['TWILIO_API_KEY_SECRET'];
    expect(() => getChannels()).toThrow(/TWILIO_API_KEY_SECRET/);
  });

  it.each([
    ['TWILIO_ACCOUNT_SID', 'not-an-account-sid'],
    ['TWILIO_ACCOUNT_SID', `AC${'g'.repeat(32)}`],
    ['TWILIO_API_KEY_SID', 'not-an-api-key-sid'],
    ['TWILIO_API_KEY_SID', `SK${'g'.repeat(32)}`],
    ['TWILIO_FROM', 'not-a-phone-number'],
  ])('rejects malformed %s before any provider call', (name, value) => {
    configure();
    vi.stubEnv(name, value);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    expect(() => getChannels()).toThrow(name);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(paddedTwilioIdentities)('rejects literal $position $whitespace in $name before a provider call', ({ name, value }) => {
    configure();
    vi.stubEnv(name, value);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    expect(() => getChannels()).toThrow(name);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('never includes provider body or credential material in HTTP errors', async () => {
    configure();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('test-key-secret legacy-master-token provider-private-body', { status: 401 })));
    await expect(getChannels().sms.sendSms('+5926000000', 'test'))
      .rejects.toThrow(/^Twilio SMS failed \(401\)$/);
  });

  it('never includes fetch exception or invalid response body in errors', async () => {
    configure();
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('test-key-secret network-private-body')));
    await expect(getChannels().sms.sendSms('+5926000000', 'test'))
      .rejects.toThrow(/^Twilio SMS request failed$/);

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('test-key-secret malformed-body', { status: 200 })));
    await expect(getChannels().sms.sendSms('+5926000000', 'test'))
      .rejects.toThrow(/^Twilio SMS response invalid$/);
  });

  it.each([
    {},
    { sid: null },
    { sid: 'test-key-secret provider-private-body' },
    { sid: `SM${'g'.repeat(32)}` },
    { sid: `SM${'a'.repeat(31)}` },
    { sid: `SM${'a'.repeat(33)}` },
  ])('rejects a successful response without a valid Message SID', async (payload) => {
    configure();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(payload), { status: 201 })));
    await expect(getChannels().sms.sendSms('+5926000000', 'test'))
      .rejects.toThrow(/^Twilio SMS response invalid$/);
  });

  it('keeps the eight-second request timeout and redacts the abort exception', async () => {
    configure();
    vi.useFakeTimers();
    try {
      vi.stubGlobal('fetch', vi.fn((_url: string, init: { signal: AbortSignal }) => new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(new Error('test-key-secret abort-private-body')));
      })));
      const pending = expect(getChannels().sms.sendSms('+5926000000', 'test'))
        .rejects.toThrow(/^Twilio SMS timed out$/);
      await vi.advanceTimersByTimeAsync(8_000);
      await pending;
    } finally {
      vi.useRealTimers();
    }
  });
});
