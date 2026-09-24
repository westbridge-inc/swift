import { afterEach, describe, expect, it, vi } from 'vitest';
import { getChannels } from '../providers/notifications/channels';

const accountSid = `AC${'a'.repeat(32)}`;
const keySid = `SK${'b'.repeat(32)}`;
const messagingServiceSid = `MG${'c'.repeat(32)}`;
const paddedTwilioIdentities = ([
  ['TWILIO_ACCOUNT_SID', accountSid],
  ['TWILIO_API_KEY_SID', keySid],
  ['TWILIO_FROM', '+15550000000'],
  ['TWILIO_MESSAGING_SERVICE_SID', messagingServiceSid],
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
  vi.stubEnv('TWILIO_MESSAGING_SERVICE_SID', '');
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
    vi.stubEnv('TWILIO_MESSAGING_SERVICE_SID', '');
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

  it('sends with MessagingServiceSid — and no From — when TWILIO_MESSAGING_SERVICE_SID is configured', async () => {
    configure();
    vi.stubEnv('TWILIO_FROM', '');
    vi.stubEnv('TWILIO_MESSAGING_SERVICE_SID', messagingServiceSid);
    const messageSid = `SM${'0'.repeat(32)}`;
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ sid: messageSid }), { status: 201 }));
    vi.stubGlobal('fetch', fetchMock);

    expect(await getChannels().sms.sendSms('+5927000000', 'test body')).toEqual({ ref: messageSid });
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, { headers: Record<string, string>; body: string; signal: AbortSignal }];
    expect(url).toBe(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`);
    // The exact form body Twilio receives: MessagingServiceSid replaces From.
    expect(init.body).toBe(
      new URLSearchParams({ To: '+5927000000', MessagingServiceSid: messagingServiceSid, Body: 'test body' }).toString(),
    );
    const params = new URLSearchParams(init.body);
    expect(params.get('MessagingServiceSid')).toBe(messagingServiceSid);
    expect(params.get('From')).toBeNull();
  });

  it('keeps From — and never adds MessagingServiceSid — when only TWILIO_FROM is set', async () => {
    configure();
    vi.stubEnv('TWILIO_MESSAGING_SERVICE_SID', '');
    const messageSid = `SM${'0'.repeat(32)}`;
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ sid: messageSid }), { status: 201 }));
    vi.stubGlobal('fetch', fetchMock);

    expect(await getChannels().sms.sendSms('+5927000000', 'test body')).toEqual({ ref: messageSid });
    expect(fetchMock).toHaveBeenCalledOnce();
    const [, init] = fetchMock.mock.calls[0] as [string, { body: string }];
    expect(init.body).toBe(
      new URLSearchParams({ To: '+5927000000', From: '+15550000000', Body: 'test body' }).toString(),
    );
    const params = new URLSearchParams(init.body);
    expect(params.get('From')).toBe('+15550000000');
    expect(params.get('MessagingServiceSid')).toBeNull();
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

  // As the SOLE sender, so the only possible refusal is the format itself (with
  // TWILIO_FROM also set, a wrongly accepted SID would still be refused as
  // both-set and this test would not notice). The owner-specified format is
  // exactly ^MG[0-9a-f]{32}$: lowercase hex, 32 digits.
  it.each([
    'not-a-messaging-service-sid',
    `MG${'g'.repeat(32)}`,
    `MG${'C'.repeat(32)}`,
    `MG${'c'.repeat(31)}`,
    `MG${'c'.repeat(33)}`,
  ])('rejects malformed TWILIO_MESSAGING_SERVICE_SID %s as the sole sender before any provider call', (value) => {
    configure();
    vi.stubEnv('TWILIO_FROM', '');
    vi.stubEnv('TWILIO_MESSAGING_SERVICE_SID', value);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    expect(() => getChannels()).toThrow(/^TWILIO_MESSAGING_SERVICE_SID is missing or malformed/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses both TWILIO_FROM and TWILIO_MESSAGING_SERVICE_SID before any provider call', () => {
    configure();
    vi.stubEnv('TWILIO_MESSAGING_SERVICE_SID', messagingServiceSid);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    expect(() => getChannels()).toThrow(/TWILIO_FROM and TWILIO_MESSAGING_SERVICE_SID/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses neither sender before any provider call', () => {
    configure();
    vi.stubEnv('TWILIO_FROM', '');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    expect(() => getChannels()).toThrow(/TWILIO_FROM or TWILIO_MESSAGING_SERVICE_SID/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sender refusals name the variables and never echo a configured Twilio value', () => {
    const malformedSid = `MG${'g'.repeat(32)}`;
    const configuredValues = [accountSid, keySid, 'test-key-secret', 'legacy-master-token', '+15550000000', messagingServiceSid, malformedSid];
    const refusals: Array<[string, () => void]> = [
      ['both senders', () => vi.stubEnv('TWILIO_MESSAGING_SERVICE_SID', messagingServiceSid)],
      ['neither sender', () => vi.stubEnv('TWILIO_FROM', '')],
      ['malformed SID', () => { vi.stubEnv('TWILIO_FROM', ''); vi.stubEnv('TWILIO_MESSAGING_SERVICE_SID', malformedSid); }],
    ];
    for (const [label, arrange] of refusals) {
      configure();
      arrange();
      let message = '';
      try { getChannels(); } catch (error) { message = (error as Error).message; }
      expect(message, label).toMatch(/^TWILIO_/);
      for (const value of configuredValues) expect(message, `${label} echoes ${value}`).not.toContain(value);
      vi.unstubAllEnvs();
    }
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

// The sender rule lives in the adapter's constructor, which every runtime mode
// reaches at app build (AuthService is constructed by the auth and socket
// plugins). Staging runs NODE_ENV=loadtest with NOTIFICATION_PROVIDER=twilio,
// where the production boot guard does not run — so the adapter itself must
// refuse and accept exactly as production does.
describe.each(['loadtest', 'production'] as const)('the exactly-one sender rule under NODE_ENV=%s', (mode) => {
  function configureMode() {
    configure();
    vi.stubEnv('NODE_ENV', mode);
    // DevPush refuses production on its own; that guard is not under test here.
    vi.stubEnv('PUSH_PROVIDER', 'expo');
  }

  it('constructs with the Messaging Service SID alone and sends MessagingServiceSid, not From', async () => {
    configureMode();
    vi.stubEnv('TWILIO_FROM', '');
    vi.stubEnv('TWILIO_MESSAGING_SERVICE_SID', messagingServiceSid);
    const messageSid = `SM${'0'.repeat(32)}`;
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ sid: messageSid }), { status: 201 }));
    vi.stubGlobal('fetch', fetchMock);

    expect(await getChannels().sms.sendSms('+5927000000', 'test body')).toEqual({ ref: messageSid });
    const [, init] = fetchMock.mock.calls[0] as [string, { body: string }];
    expect(init.body).toBe(
      new URLSearchParams({ To: '+5927000000', MessagingServiceSid: messagingServiceSid, Body: 'test body' }).toString(),
    );
  });

  it('refuses both senders, neither sender and a malformed SID before any provider call', () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    configureMode();
    vi.stubEnv('TWILIO_MESSAGING_SERVICE_SID', messagingServiceSid);
    expect(() => getChannels()).toThrow(/TWILIO_FROM and TWILIO_MESSAGING_SERVICE_SID/);

    configureMode();
    vi.stubEnv('TWILIO_FROM', '');
    expect(() => getChannels()).toThrow(/TWILIO_FROM or TWILIO_MESSAGING_SERVICE_SID/);

    configureMode();
    vi.stubEnv('TWILIO_FROM', '');
    vi.stubEnv('TWILIO_MESSAGING_SERVICE_SID', 'not-a-messaging-service-sid');
    expect(() => getChannels()).toThrow(/TWILIO_MESSAGING_SERVICE_SID/);

    expect(fetchMock).not.toHaveBeenCalled();
  });
});
