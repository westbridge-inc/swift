/**
 * [VIEWER-FIX · 1 Nov 2026] A 500 is always logged, in words that name its
 * cause and nothing else.
 *
 * The document viewer's 500 under the tenant wall left no error line: the
 * wall's refusal (TenantContextRequiredError) carries its own statusCode, and
 * the handler answered such errors without logging them; only an error with
 * no status was logged, and the logger's serializer redacts that error's
 * message and class. So the only trace was "request completed" with a 500.
 *
 * With the production logger settings (redaction and serializers), here:
 *  - a refusal that carries its own 5xx status is logged at error level with
 *    its class, code, the model and operation it names, the status and the
 *    route TEMPLATE, and answers exactly as before;
 *  - an error with no status is logged as before, now naming its class;
 *  - neither line carries the error's message, the request's path values or
 *    its query string, and a code that is not a plain identifier is left out;
 *  - a 4xx and an AppError refusal stay off the error log, as before.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { Writable } from 'node:stream';
import { registerErrorHandler } from '../middleware/error-handler';
import { loggerRedactConfig, loggerSerializers } from '../utils/logger-config';
import { TenantContextRequiredError } from '../plugins/prisma';
import { AppError } from '../utils/errors';

const SECRET = 'sk-ViewerFixSecret-9137';
const PATH_VALUE = 'doc9137pathvalue';
let app: FastifyInstance;
const lines: Array<Record<string, unknown>> = [];
let raw = '';

beforeAll(async () => {
  const stream = new Writable({ write(chunk, _encoding, done) {
    raw += String(chunk);
    for (const line of String(chunk).split('\n')) if (line.trim()) lines.push(JSON.parse(line) as Record<string, unknown>);
    done();
  } });
  app = Fastify({ logger: { level: 'info', stream, redact: loggerRedactConfig, serializers: loggerSerializers } });
  registerErrorHandler(app);
  app.get('/probe/wall/:id', async () => { throw new TenantContextRequiredError('User', 'findUnique', 'request'); });
  app.get('/probe/status/:id', async () => {
    throw Object.assign(new Error(`upstream refused https://bucket.example/${SECRET}`), { statusCode: 502, code: 'UPSTREAM_REFUSED' });
  });
  app.get('/probe/odd-code/:id', async () => {
    throw Object.assign(new Error(`refused ${SECRET}`), { statusCode: 500, code: `https://bucket.example/${SECRET}` });
  });
  app.get('/probe/unknown/:id', async () => { throw new RangeError(`out of range for ${SECRET}`); });
  app.get('/probe/client/:id', async () => { throw Object.assign(new Error(`too many ${SECRET}`), { statusCode: 429, code: 'SLOW_DOWN' }); });
  app.get('/probe/app-error/:id', async () => { throw new AppError(503, 'ENCRYPTION_OFF', 'Encryption is not configured.'); });
  await app.ready();
});

afterAll(async () => { await app.close(); });

const errorLines = (route: string) => lines.filter((l) => l['level'] === 50 && l['route'] === route);
const get = (path: string) => app.inject({ method: 'GET', url: `${path}/${PATH_VALUE}?sig=${SECRET}&expires=1` });

describe('[VIEWER-FIX] every 5xx leaves an error line that names its cause, and only its cause', () => {
  it('the tenant wall’s refusal (its own 500) is logged with class, code, model, operation and route template, and answers as before', async () => {
    const res = await get('/probe/wall');
    expect(res.statusCode).toBe(500);
    expect(res.json().error.code).toBe('TENANT_CONTEXT_REQUIRED');
    const logged = errorLines('/probe/wall/:id');
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({
      msg: 'Unhandled error', method: 'GET', statusCode: 500,
      errorClass: 'TenantContextRequiredError', errorCode: 'TENANT_CONTEXT_REQUIRED', model: 'User', operation: 'findUnique',
    });
  });

  it('any error carrying its own 5xx status is logged by class and code, never by its message', async () => {
    expect((await get('/probe/status')).statusCode).toBe(502);
    const logged = errorLines('/probe/status/:id');
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({ statusCode: 502, errorClass: 'Error', errorCode: 'UPSTREAM_REFUSED' });
  });

  it('a code that is not a plain identifier is left out of the line', async () => {
    expect((await get('/probe/odd-code')).statusCode).toBe(500);
    const logged = errorLines('/probe/odd-code/:id');
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({ statusCode: 500, errorClass: 'Error' });
    expect(logged[0]).not.toHaveProperty('errorCode');
  });

  it('an error with no status is logged as before, and now names its class', async () => {
    expect((await get('/probe/unknown')).statusCode).toBe(500);
    const logged = errorLines('/probe/unknown/:id');
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({ msg: 'Unhandled error', errorClass: 'RangeError' });
  });

  it('a 4xx and a deliberate AppError refusal stay off the error log, as before', async () => {
    expect((await get('/probe/client')).statusCode).toBe(429);
    expect((await get('/probe/app-error')).statusCode).toBe(503);
    expect(errorLines('/probe/client/:id')).toEqual([]);
    expect(errorLines('/probe/app-error/:id')).toEqual([]);
  });

  it('no line carries an error message, a path value or the query string', () => {
    expect(raw.length).toBeGreaterThan(0);
    for (const forbidden of [SECRET, PATH_VALUE, 'sig=', 'bucket.example', 'reached the database']) expect(raw).not.toContain(forbidden);
  });
});
