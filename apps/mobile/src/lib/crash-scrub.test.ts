import { describe, expect, it } from 'vitest';
import { scrubCrashBreadcrumb, scrubCrashEvent, scrubCrashText } from './crash-scrub';

/**
 * [L13 item 7] Nothing that names or reaches a person leaves the phone in a
 * crash report. All values below are SYNTHETIC (555 numbers, example.com).
 */
const PHONE_INTL = '+592 555 0142';
const PHONE_DIGITS = '5925550143';
const PHONE_LOCAL = '555-0177';
const PHONE_LOCAL_BARE = '5550199';
const PHONE_OTHER = '+1 (868) 555-0100';
const EMAIL = 'jane.doe@example.com';
const NAME = 'Jane Doe';
const ADDRESS = '12 Synthetic Street, Kitty';
// Assembled at runtime so the synthetic token is not a literal in source.
const JWT = ['eyJhbGciOiJIUzI1NiJ9', 'eyJzdWIiOiJzeW50aGV0aWMifQ', 'c2lnbmF0dXJl'].join('.');
const BEARER_VALUE = 'opaqueSessionValue123';
const SIGNED_QUERY = 'X-Amz-Signature=abc123def&X-Amz-Credential=synthetic';
const SEARCH_TERM = 'insulin';

const PII = [
  PHONE_INTL, PHONE_DIGITS, PHONE_LOCAL, PHONE_LOCAL_BARE, '555 0142', '0142', '0143', '0177', '0199', '0100',
  EMAIL, NAME, 'Jane', ADDRESS, 'Synthetic Street', JWT, 'eyJhbGciOiJIUzI1NiJ9', BEARER_VALUE,
  'abc123def', SEARCH_TERM, 'trk_synthetic_token', '203.0.113.7', 'install-id-synthetic',
];

function leaked(value: unknown): string[] {
  const text = JSON.stringify(value);
  return PII.filter((needle) => text.includes(needle));
}

function hostileEvent() {
  return {
    event_id: 'e1',
    message: `checkout failed for ${PHONE_INTL} / ${EMAIL}`,
    exception: {
      values: [{
        type: 'Error',
        value: `profile save failed: phone ${PHONE_DIGITS}, local ${PHONE_LOCAL}, alt ${PHONE_LOCAL_BARE}, intl ${PHONE_OTHER}`,
        stacktrace: { frames: [{ filename: 'app:///index.android.bundle', function: 'save', lineno: 10, colno: 2 }] },
      }],
    },
    user: { id: 'user_1', username: NAME, email: EMAIL, phone: PHONE_INTL, ip_address: '203.0.113.7' },
    request: {
      url: `https://api.swiftgy.com/api/v1/search?q=${SEARCH_TERM}&${SIGNED_QUERY}`,
      headers: { Authorization: `Bearer ${BEARER_VALUE}` },
      cookies: { session: BEARER_VALUE },
      data: { name: NAME, address: ADDRESS },
      query_string: `q=${SEARCH_TERM}`,
    },
    extra: {
      fatal: true,
      source: 'boundary',
      componentStack: '\n    in CheckoutScreen',
      customer: { name: NAME, phone: PHONE_INTL, address: ADDRESS },
      token: JWT,
    },
    contexts: {
      device: { name: `${NAME}'s iPhone`, model: 'iPhone15,2', device_unique_identifier: 'install-id-synthetic' },
      os: { name: 'iOS', version: '18.0' },
      user: { name: NAME },
    },
    tags: { note: `call ${PHONE_LOCAL_BARE}` },
    server_name: `${NAME}'s iPhone`,
    breadcrumbs: [
      { category: 'console', message: `logged in as ${NAME} ${PHONE_INTL}` },
      { category: 'touch', message: `Touch event within element: ${NAME}` },
      { category: 'ui.click', message: `button "${EMAIL}"` },
      { type: 'user', message: NAME },
      { category: 'navigation', data: { from: { name: 'Home', params: { address: ADDRESS } }, to: { name: 'Checkout', params: { phone: PHONE_INTL } } } },
      {
        type: 'http', category: 'xhr',
        data: { method: 'GET', status_code: 500, url: `https://api.swiftgy.com/api/v1/track/trk_synthetic_token?${SIGNED_QUERY}`, request_body: { name: NAME } },
      },
      { category: 'app', message: `Authorization: Bearer ${BEARER_VALUE}`, data: { who: NAME } },
    ],
  };
}

describe('crash reports carry no person (L13 item 7)', () => {
  it('a hostile event loses every phone number, name, e-mail, address, token and query', () => {
    const out = scrubCrashEvent(hostileEvent());
    expect(leaked(out)).toEqual([]);
  });

  it('structural drops: user, request body/headers/cookies/query, device name and id, server name', () => {
    const out = scrubCrashEvent(hostileEvent()) as any;
    expect(out.user).toBeUndefined();
    expect(out.server_name).toBeUndefined();
    expect(out.request).toEqual({ url: 'https://api.swiftgy.com/api/v1/search' });
    expect(out.contexts.device).toEqual({ model: 'iPhone15,2' });
    expect(out.contexts.user).toBeUndefined();
    expect(Object.keys(out.extra).sort()).toEqual(['componentStack', 'fatal', 'source']);
  });

  it('keeps the diagnostic value: error type, stack frames, route names, HTTP method and status', () => {
    const out = scrubCrashEvent(hostileEvent()) as any;
    expect(out.exception.values[0].type).toBe('Error');
    expect(out.exception.values[0].stacktrace.frames[0]).toEqual({ filename: 'app:///index.android.bundle', function: 'save', lineno: 10, colno: 2 });
    expect(out.exception.values[0].value).toMatch(/^profile save failed: phone \[redacted\]/);
    expect(out.breadcrumbs).toEqual([
      { category: 'navigation', data: { from: 'Home', to: 'Checkout' } },
      { type: 'http', category: 'xhr', data: { method: 'GET', status_code: 500, url: 'https://api.swiftgy.com/api/v1/track/[redacted]' } },
      { category: 'app', message: 'Authorization: Bearer [redacted]' },
    ]);
  });

  it('does not mutate the caller\'s event', () => {
    const event = hostileEvent();
    scrubCrashEvent(event);
    expect(event.user.phone).toBe(PHONE_INTL);
  });

  it('beforeBreadcrumb drops console, touch, ui and user breadcrumbs outright', () => {
    for (const crumb of hostileEvent().breadcrumbs.slice(0, 4)) {
      expect(scrubCrashBreadcrumb(crumb)).toBeNull();
    }
  });

  it('text redaction covers every phone spelling, e-mail, JWT and bearer value', () => {
    for (const phone of [PHONE_INTL, '(592) 555-0142', '592-555-0142', PHONE_DIGITS, PHONE_LOCAL, '555 0177', PHONE_LOCAL_BARE, PHONE_OTHER]) {
      expect(scrubCrashText(`x ${phone} y`), phone).toBe('x [redacted] y');
    }
    expect(scrubCrashText(`mail ${EMAIL}`)).toBe('mail [redacted]');
    expect(scrubCrashText(`jwt ${JWT}`)).toBe('jwt [redacted]');
    expect(scrubCrashText(`Bearer ${BEARER_VALUE}`)).toBe('Bearer [redacted]');
    expect(scrubCrashText(`/public/trip/trk_synthetic_token?${SIGNED_QUERY}`)).toBe('/public/trip/[redacted]');
  });
});
