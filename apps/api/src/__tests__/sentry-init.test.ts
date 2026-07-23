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
