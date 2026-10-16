import { describe, expect, it } from 'vitest';
import { scrubSentryEvent } from '../plugins/observability';

// [M013] Error reports (Sentry beforeSend, API and worker) carry no credential,
// however deep it sits and whether or not it looks like a URL. The scrubber
// already removed URL queries, token paths and request bodies; these cases are
// the shapes that slipped through. All values are synthetic.

type Loose = Record<string, unknown>;
const scrub = (event: Loose) => JSON.stringify(scrubSentryEvent(event as never));

describe('[M013] error reports: nested credentials, by field name', () => {
  it('credential fields are removed at any depth; correlation and classification stay', () => {
    const out = scrub({
      request: {},
      extra: {
        requestId: 'safe-correlation', statusCode: 503, queue: 'notification-jobs', jobId: 'safe-job-id',
        upstream: {
          headers: { authorization: 'Bearer synthetic-upstream-authorization', 'x-trace': 'synthetic-header-value' },
          cookies: 'session=synthetic-cookie',
          refreshToken: 'synthetic-refresh', access_token: 'synthetic-access', idToken: 'synthetic-id-token',
          password: 'synthetic-password', passwordHash: 'synthetic-hash', otp: 'synthetic-otp', pin: '4821',
          ridePin: '7319', pickupCode: '5544', deliveryPin: '6655', signInUrl: 'synthetic-sign-in-url',
          magicLink: 'synthetic-magic', clientSecret: 'synthetic-client-secret', apiKey: 'synthetic-api-key',
          mkey: 'synthetic-mkey', msecret: 'synthetic-msecret', mmgPassword: 'synthetic-mmg', cardNumber: '4111111111111111', cvc: '123',
          'set-cookie': ['sid=synthetic-set-cookie'],
        },
        attempt: { code: '918273' },
        classification: { code: 'SMS_SEND_FAILED', prisma: { code: 'P2002' } },
      },
    });
    for (const marker of [
      'synthetic-upstream-authorization', 'synthetic-header-value', 'synthetic-cookie', 'synthetic-refresh', 'synthetic-access',
      'synthetic-id-token', 'synthetic-password', 'synthetic-hash', 'synthetic-otp', '4821', '7319', '5544', '6655',
      'synthetic-sign-in-url', 'synthetic-magic', 'synthetic-client-secret', 'synthetic-api-key', 'synthetic-mkey',
      'synthetic-msecret', 'synthetic-mmg', '4111111111111111', '"123"', 'synthetic-set-cookie', '918273',
    ]) expect(out, `${marker} reached the error report`).not.toContain(marker);
    for (const kept of ['safe-correlation', '503', 'notification-jobs', 'safe-job-id', 'SMS_SEND_FAILED', 'P2002']) {
      expect(out, `${kept} must stay for triage`).toContain(kept);
    }
  });

  it('a share link without the /public prefix loses its token, like /track and /public/trip', () => {
    const out = scrub({ request: {}, extra: { link: 'https://swiftgy.com/trip/synthetic-trip-grant', path: '/trip/synthetic-trip-grant-2' } });
    expect(out).not.toContain('synthetic-trip-grant');
    expect(out).toContain('/trip/[scrubbed]');
  });
});

describe('[M013] error reports: free text can carry a bare code, so it is not sent', () => {
  it('exception, message, breadcrumb and upstream text are withheld; the error type and stack stay', () => {
    const out = scrub({
      request: {},
      message: 'Sign in using synthetic-top-code',
      logentry: { message: 'Code synthetic-logentry-code', formatted: 'Code synthetic-formatted-code' },
      exception: { values: [{
        type: 'DeliveryError', value: 'Provider rejected text: your code is 771204',
        stacktrace: { frames: [{ filename: 'app:///dist/jobs/queue.js', function: 'sendNotification', lineno: 42 }] },
      }] },
      breadcrumbs: [{ category: 'console', message: 'Sending code synthetic-breadcrumb-code' }],
      extra: { upstream: { message: 'Rejected message synthetic-upstream-code', body: 'Your Swift verification code is: 660301', text: 'code 550912' }, requestId: 'safe-correlation' },
    });
    for (const marker of ['synthetic-top-code', 'synthetic-logentry-code', 'synthetic-formatted-code', '771204', 'synthetic-breadcrumb-code', 'synthetic-upstream-code', '660301', '550912']) {
      expect(out, `${marker} reached the error report`).not.toContain(marker);
    }
    for (const kept of ['DeliveryError', 'sendNotification', 'app:///dist/jobs/queue.js', '"lineno":42', 'console', 'safe-correlation']) {
      expect(out, `${kept} must stay for triage`).toContain(kept);
    }
  });
});

describe('[M013] error reports: what the scrubber cannot reach is not sent', () => {
  it('an object past the traversal budget is withheld rather than sent unread', () => {
    let nested: Loose = { note: 'synthetic-deep-grant' };
    for (let depth = 0; depth < 12; depth += 1) nested = { cause: nested };
    const out = scrub({ request: {}, extra: nested });
    expect(out).not.toContain('synthetic-deep-grant');
    expect(out).toContain('[scrubbed]');
  });

  it('an array past the traversal budget is withheld too', () => {
    let nested: unknown = ['synthetic-deep-array-grant'];
    for (let depth = 0; depth < 12; depth += 1) nested = [nested];
    expect(scrub({ request: {}, extra: { nested } })).not.toContain('synthetic-deep-array-grant');
  });
});

describe('[M013] the SDK keeps working', () => {
  it("the SDK's own processing state (deleted before sending) is never rewritten", () => {
    // A live scope/client stand-in: header maps, deep options and strings that
    // look like credentials. Replacing any of it would break later events.
    let deep: Loose = { leaf: 'token=synthetic-live-value' };
    for (let depth = 0; depth < 12; depth += 1) deep = { next: deep };
    const live = { _client: { _options: { transportOptions: { headers: { 'x-sentry-auth': 'synthetic-live-auth' } }, deep } }, message: 'live message' };
    const before = JSON.stringify(live);
    const event = scrubSentryEvent({ request: {}, sdkProcessingMetadata: { capturedSpanScope: live } } as never) as Loose;
    expect((event['sdkProcessingMetadata'] as Loose)['capturedSpanScope']).toBe(live);
    expect(JSON.stringify(live)).toBe(before);
  });
});
