import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import * as Sentry from '@sentry/node';
import { initSentry, captureError, resetSentryForTests } from '../plugins/observability';

// SWIFT-042 — the worker process is a SEPARATE entrypoint; if it never calls
// initSentry, captureError (used by every job failure handler) is a silent
// no-op and worker crashes vanish. This pins the contract initSentry/captureError
// share, with @sentry/node mocked so nothing touches the network.

vi.mock('@sentry/node', () => ({ init: vi.fn(), captureException: vi.fn() }));

const savedDsn = process.env['SENTRY_DSN'];

beforeEach(() => {
  resetSentryForTests();
  vi.clearAllMocks();
});

afterAll(() => {
  if (savedDsn === undefined) delete process.env['SENTRY_DSN'];
  else process.env['SENTRY_DSN'] = savedDsn;
  resetSentryForTests();
});

describe('initSentry / captureError contract [SWIFT-042]', () => {
  it('captureError is a silent no-op until initSentry runs (the un-inited worker bug)', () => {
    delete process.env['SENTRY_DSN'];
    captureError(new Error('boom before init'));
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  it('initSentry with a DSN initializes ONCE (idempotent) and then captureError delivers', () => {
    process.env['SENTRY_DSN'] = 'https://examplePublicKey@o0.ingest.sentry.io/1';
    expect(initSentry()).toBe(true);
    expect(Sentry.init).toHaveBeenCalledTimes(1);
    // A second boot (e.g. server + worker in one process during tests) is a no-op.
    initSentry();
    expect(Sentry.init).toHaveBeenCalledTimes(1);
    // Now a worker job failure reaches Sentry.
    captureError(new Error('job failed'), { jobId: 'x' });
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
  });

  it('initSentry without a DSN is a safe no-op (never inits, never throws)', () => {
    delete process.env['SENTRY_DSN'];
    expect(initSentry()).toBeFalsy();
    expect(Sentry.init).not.toHaveBeenCalled();
  });
});

describe('event scrubbing [REPORT-013 F-013-04]', () => {
  it('tokenized public URLs, querystrings, headers, cookies and body never leave', async () => {
    const { scrubSentryEvent } = await import('../plugins/observability');
    const event = scrubSentryEvent({
      request: {
        url: 'https://api.swift.gy/api/v1/courier/track/SEKRET123abc?sig=deadbeef&x=1',
        query_string: 'sig=deadbeef',
        headers: { authorization: 'Bearer topsecret' },
        cookies: 'session=abc',
        data: { phone: '+5926001234' },
      },
      extra: { url: '/api/v1/safety/public/trip/tok_9f8e7d?token=abc123' },
      breadcrumbs: [{ message: 'GET /render/doc999?expires=1&sig=beef', data: { url: '/track/zzz' } }],
    });
    expect(event.request!.url).not.toContain('SEKRET123abc');
    expect(event.request!.url).not.toContain('deadbeef');
    expect(event.request!.query_string).toBeUndefined();
    expect(event.request!.headers).toBeUndefined();
    expect(event.request!.cookies).toBeUndefined();
    expect(event.request!.data).toBeUndefined();
    expect(String(event.extra!['url'])).not.toContain('tok_9f8e7d');
    expect(String(event.extra!['url'])).not.toContain('abc123');
    expect(event.breadcrumbs![0]!.message).not.toContain('beef');
    expect(String(event.breadcrumbs![0]!.data!['url'])).not.toContain('zzz');
  });

  it('init wires the scrubber as beforeSend', () => {
    process.env['SENTRY_DSN'] = 'https://x@sentry.example/1';
    initSentry();
    const initArg = (Sentry.init as ReturnType<typeof vi.fn>).mock.calls[0]![0] as { beforeSend?: unknown };
    expect(typeof initArg.beforeSend).toBe('function');
  });
});
