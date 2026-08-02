import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { createHmac } from 'node:crypto';
import { registerEmptyJsonBodyParser } from '../plugins/empty-json';
import { registerErrorHandler } from '../middleware/error-handler';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { socketPlugin } from '../plugins/socket';
import { agentCashRoutes } from '../modules/billing/agent-cash.routes';

// Boot regression: server.ts composes the GLOBAL empty-json body parser with
// the agent-cash plugin. The plugin's first cut re-added an application/json
// parser → FST_ERR_CTP_ALREADY_PRESENT at BOOT, dev API dead — and CI never
// boots the full composition, so only a human found it. This test IS that
// boot: both registered together, ready() must succeed, and the HMAC (which
// depends on exact raw bytes) must still verify through the preParsing tee.

const SECRET = 'boot-regression-secret-0123456789';
let app: FastifyInstance;

beforeAll(async () => {
  process.env['NODE_ENV'] = 'development';
  process.env['DATABASE_URL'] = process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift_test';
  process.env['REDIS_URL'] = process.env['REDIS_URL'] || 'redis://localhost:6382';
  process.env['AGENT_CASH_WEBHOOK_SECRET'] = SECRET;

  app = Fastify({ logger: false });
  registerErrorHandler(app);
  registerEmptyJsonBodyParser(app); // the server's REAL global parser — the collision partner
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(socketPlugin);
  await app.register(agentCashRoutes, { prefix: '/api/v1/billing/mmg' });
  await app.ready(); // the boot itself is the assertion
});

afterAll(async () => {
  delete process.env['AGENT_CASH_WEBHOOK_SECRET'];
  await app.close();
});

describe('server composition boot (FST_ERR_CTP_ALREADY_PRESENT regression)', () => {
  it('boots with the global empty-json parser AND the agent-cash plugin together', () => {
    expect(app.hasRoute({ method: 'POST', url: '/api/v1/billing/mmg/inquiry' })).toBe(true);
  });

  it('the HMAC still verifies over exact raw bytes through the preParsing tee', async () => {
    const raw = JSON.stringify({ accountNumber: '472-905-8836' });
    const ts = Date.now();
    const sig = createHmac('sha256', SECRET).update(`${ts}.`).update(Buffer.from(raw)).digest('hex');
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/billing/mmg/inquiry',
      payload: raw,
      headers: { 'content-type': 'application/json', 'x-swift-timestamp': String(ts), 'x-swift-signature': sig },
    });
    // Signature accepted (not 401/503) — the SAN itself is a random example,
    // so any of the valid:false reasons proves auth passed and parsing ran.
    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveProperty('valid');
  });

  it('empty-body POSTs elsewhere in scope still parse as {} (the global parser law holds)', async () => {
    const ts = Date.now();
    const sig = createHmac('sha256', SECRET).update(`${ts}.`).digest('hex'); // empty raw body
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/billing/mmg/inquiry',
      payload: '',
      headers: { 'content-type': 'application/json', 'x-swift-timestamp': String(ts), 'x-swift-signature': sig },
    });
    // Zod then rejects the missing accountNumber — a 400, never a parser 500/boot failure.
    expect([200, 400]).toContain(res.statusCode);
  });
});
