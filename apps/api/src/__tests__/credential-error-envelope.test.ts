import { afterAll, describe, expect, it, vi } from 'vitest';

// [M013 · #1795 S4-3] The whole path, not only the scrubber: the real initSentry() options, a real Sentry client, and a
// transport that keeps the envelope it is handed instead of sending it. Whatever the SDK adds around beforeSend
// (breadcrumbs, contexts, envelope headers) is in what this transport receives. All values are synthetic; nothing
// leaves the process (the DSN host is example.invalid and the transport never makes a request).
const sent = vi.hoisted(() => [] as string[]);
vi.mock('@sentry/node', async (importOriginal) => {
  const real = await importOriginal<typeof import('@sentry/node')>();
  return {
    ...real,
    init: (options: Parameters<typeof real.init>[0]) => real.init({
      ...options,
      transport: () => ({
        send: async (envelope: unknown) => {
          sent.push(JSON.stringify(envelope));
          return {};
        },
        flush: async () => true,
      }),
    }),
  };
});

import * as Sentry from '@sentry/node';
import { captureError, initSentry, resetSentryForTests } from '../plugins/observability';

describe('[M013 · S4-3] the envelope an error report becomes carries no credential', () => {
  afterAll(async () => {
    await Sentry.close(0);
    resetSentryForTests();
    delete process.env['SENTRY_DSN'];
  });

  // The SDK attaches the source lines around each stack frame (this file's own lines here), so every synthetic value
  // is assembled at run time: the source never holds one, and only a leak of the runtime value can fail this test.
  const grant = (name: string) => ['synthetic', name, 'grant'].join('-');
  const code = ['9182', '73'].join('');

  it('a grant in the error text, its context and a breadcrumb reaches the transport only as [scrubbed]', async () => {
    process.env['SENTRY_DSN'] = 'https://synthetic0dsn0key@example.invalid/1';
    expect(initSentry()).toBe(true);
    Sentry.addBreadcrumb({
      category: 'http',
      message: `GET /trip/${grant('breadcrumb')}`,
      data: { url: `https://swiftgy.com/track/${grant('track')}?token=${grant('query')}` },
    });
    captureError(new Error(`Upstream refused code ${code} for /trip/${grant('message')}`), {
      requestId: 'safe-correlation',
      link: `https://swiftgy.com/trip/${grant('context')}`,
      refreshToken: grant('refresh'),
      upstream: { signInUrl: grant('sign-in'), detail: `see /public/trip/${grant('detail')}` },
    });
    await Sentry.flush(2000);

    const envelope = sent.join('\n');
    expect(envelope, 'the transport received no event, so nothing was proven').toContain('"type":"event"');
    for (const marker of [
      grant('breadcrumb'), grant('track'), grant('query'), code, grant('message'), grant('context'), grant('refresh'),
      grant('sign-in'), grant('detail'),
    ]) expect(envelope, `${marker} reached the envelope`).not.toContain(marker);
    for (const kept of ['safe-correlation', '"type":"Error"', '[scrubbed]']) expect(envelope, `${kept} must stay for triage`).toContain(kept);
  });
});
