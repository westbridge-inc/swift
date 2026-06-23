import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { registerEmptyJsonBodyParser } from '../plugins/empty-json';
import { registerErrorHandler } from '../middleware/error-handler';

// A body-less POST (Content-Type: application/json, empty body) must NOT be
// rejected with FST_ERR_CTP_EMPTY_JSON_BODY — that silently broke every action
// endpoint the axios client calls without a body (go-online, accept, …).
let app: FastifyInstance;

beforeAll(async () => {
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  registerEmptyJsonBodyParser(app);
  app.post('/echo', async (req) => ({ body: req.body }));
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

describe('empty application/json body', () => {
  it('accepts an empty body as {} (the go-online bug)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/echo',
      headers: { 'content-type': 'application/json' },
      payload: '',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().body).toEqual({});
  });

  it('still parses a real JSON body', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/echo',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ a: 1, b: 'two' }),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().body).toEqual({ a: 1, b: 'two' });
  });

  it('still rejects malformed JSON with 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/echo',
      headers: { 'content-type': 'application/json' },
      payload: '{ not valid',
    });
    expect(res.statusCode).toBe(400);
  });
});
