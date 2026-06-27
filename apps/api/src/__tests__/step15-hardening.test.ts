import { describe, it, expect } from 'vitest';
import pino from 'pino';
import { Writable } from 'node:stream';
import { loggerRedactConfig } from '../utils/logger-config';

// ---------------------------------------------------------------------------
// Step 15 (automatable slice) — secrets never reach log output, and the
// operational artifacts exist. The CI restore drill lives in ci.yml (a
// backup that has not been restored does not exist).
// ---------------------------------------------------------------------------

describe('Log redaction — the production config, not a copy', () => {
  function captureLog(write: (logger: pino.Logger) => void): string {
    let out = '';
    const sink = new Writable({
      write(chunk, _enc, cb) {
        out += chunk.toString();
        cb();
      },
    });
    const logger = pino({ redact: loggerRedactConfig }, sink);
    write(logger);
    return out;
  }

  it('redacts authorization headers, tokens, passwords, and card data', () => {
    const out = captureLog((log) =>
      log.info({
        req: { headers: { authorization: 'Bearer super-secret-jwt', cookie: 'session=abc' } },
        body: {
          password: 'hunter2-long-password',
          refreshToken: 'refresh-token-value',
          cardNumber: '4242424242424242',
          cvc: '123',
        },
        msg: 'incoming',
      }),
    );

    expect(out).not.toContain('super-secret-jwt');
    expect(out).not.toContain('hunter2-long-password');
    expect(out).not.toContain('refresh-token-value');
    expect(out).not.toContain('4242424242424242');
    expect(out).toContain('[redacted]');
  });

  it('leaves operational fields intact', () => {
    const out = captureLog((log) => log.info({ orderId: 'order-123', status: 'DELIVERED' }, 'order moved'));
    expect(out).toContain('order-123');
    expect(out).toContain('DELIVERED');
  });
});

// The runbook-exists check was removed with the internal docs (now maintained
// outside the public repo). The CI restore drill in ci.yml still proves backups.
