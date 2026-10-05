import Fastify from 'fastify';
import { Writable } from 'node:stream';
import pino from 'pino';
import { describe, expect, it } from 'vitest';
import * as config from '../utils/logger-config';
import { registerErrorHandler } from '../middleware/error-handler';

describe('MASTER-013 private request credentials', () => {
  it('redacts explicit raw URL metadata used by authentication failure logs', () => {
    let output = '';
    const stream = new Writable({ write(chunk, _encoding, done) { output += String(chunk); done(); } });
    const log = pino({ redact: config.loggerRedactConfig }, stream);
    log.error({ url: '/track/synthetic-auth-credential?sig=synthetic-auth-signature' }, 'synthetic session-store failure');
    expect(output).not.toContain('synthetic-auth-credential');
    expect(output).not.toContain('synthetic-auth-signature');
  });

  it('the error handler omits raw targets even with a logger without URL redaction', async () => {
    let output = '';
    const stream = new Writable({ write(chunk, _encoding, done) { output += String(chunk); done(); } });
    const app = Fastify({ logger: { stream, serializers: config.loggerSerializers } });
    registerErrorHandler(app);
    app.get('/track/:token', () => { throw new Error('synthetic failure'); });
    try {
      expect((await app.inject('/track/synthetic-path-credential?sig=synthetic-query-credential')).statusCode).toBe(500);
      expect(output).not.toContain('synthetic-path-credential');
      expect(output).not.toContain('synthetic-query-credential');
    } finally { await app.close(); }
  });

  it('keeps request and error logs free of path, query and nested error credentials', async () => {
    const lines: string[] = [];
    const stream = new Writable({ write(chunk, _encoding, done) { lines.push(String(chunk)); done(); } });
    const app = Fastify({ logger: {
      level: 'trace', stream, redact: config.loggerRedactConfig,
      serializers: (config as unknown as { loggerSerializers?: Record<string, (v: unknown) => unknown> }).loggerSerializers,
    } });
    registerErrorHandler(app);
    app.get('/track/:token', async (request) => {
      const err = Object.assign(new Error(`upstream refused ${request.url}`), {
        request: { url: request.url }, cause: new Error(`nested ${request.url}`),
      });
      throw err;
    });
    app.get('/verification/render/:id', async () => ({ ok: true }));
    try {
      for (const url of [
        '/track/synthetic-path-credential?sig=synthetic-query-credential',
        '/verification/render/own-id?sig=synthetic-query-credential',
        '/missing/synthetic-path-credential?sig=synthetic-query-credential',
      ]) await app.inject(url);
      const output = lines.join('');
      expect(output).not.toContain('synthetic-path-credential');
      expect(output).not.toContain('synthetic-query-credential');
      const records = lines.flatMap(line => line.trim().split('\n').map(row => JSON.parse(row)));
      expect(records.some(record => record.req?.method === 'GET')).toBe(true);
      expect(records.some(record => record.res?.statusCode === 500)).toBe(true);
      expect(records.some(record => record.reqId)).toBe(true);
    } finally { await app.close(); }
  });
});
