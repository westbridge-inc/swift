import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { createHmac } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { registerEmptyJsonBodyParser } from '../plugins/empty-json';
import { registerErrorHandler } from '../middleware/error-handler';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { socketPlugin } from '../plugins/socket';
import { agentCashRoutes, AGENT_CASH_MAX_RAW_BODY_BYTES } from '../modules/billing/agent-cash.routes';

// Boot regression: server.ts composes the GLOBAL empty-json body parser with
// the agent-cash plugin. The plugin's first cut re-added an application/json
// parser → FST_ERR_CTP_ALREADY_PRESENT at BOOT, dev API dead — and CI never
// boots the full composition, so only a human found it. This test IS that
// boot: both registered together, ready() must succeed, and the HMAC (which
// depends on exact raw bytes) must still verify through the preParsing tee.

const SECRET = 'boot-regression-secret-0123456789';
let app: FastifyInstance;
/** Route config as fastify registered it — the bodyLimit assertion reads this. */
const routeBodyLimits = new Map<string, number | undefined>();
/** What the raw-body capture saw and kept on the LAST webhook request, read
 *  server-side in onResponse: the proof that nothing past the cap was retained. */
let lastCapture: { url: string; seen: number | undefined; retained: number | undefined } | undefined;

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
  app.addHook('onRoute', (route) => {
    routeBodyLimits.set(`${String(route.method)} ${route.url}`, route.bodyLimit);
  });
  app.addHook('onResponse', async (request) => {
    const r = request as typeof request & { rawBodyBytesSeen?: number; rawBody?: Buffer };
    lastCapture = { url: request.url, seen: r.rawBodyBytesSeen, retained: r.rawBody?.length };
  });
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

  it('an oversized webhook body is refused with 413 before any signature work', async () => {
    // Correctly signed, so the ONLY reason for refusal is the size guard —
    // the old code buffers this fully, verifies the signature, and only fails
    // later in zod (400). The cap must fire first.
    const raw = JSON.stringify({
      transactionId: 'x'.repeat(AGENT_CASH_MAX_RAW_BODY_BYTES * 2),
      accountNumber: '472-905-8836',
      amount: 2100,
      currency: 'GYD',
    });
    const ts = Date.now();
    const sig = createHmac('sha256', SECRET).update(`${ts}.`).update(Buffer.from(raw)).digest('hex');
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/billing/mmg/agent-notification',
      payload: raw,
      headers: { 'content-type': 'application/json', 'x-swift-timestamp': String(ts), 'x-swift-signature': sig },
    });
    expect(res.statusCode).toBe(413);
    expect(res.json().error.code).toBe('FST_ERR_CTP_BODY_TOO_LARGE');
    // Server side: the capture decided within one chunk of the cap and kept nothing.
    expect(lastCapture?.url).toBe('/api/v1/billing/mmg/agent-notification');
    expect(lastCapture?.retained).toBeUndefined();
    expect(lastCapture?.seen).toBeLessThanOrEqual(AGENT_CASH_MAX_RAW_BODY_BYTES + 64 * 1024);
  });

  it('both MMG webhook routes are registered with the 128 KB cap as their route bodyLimit', () => {
    // Belt and braces behind the preParsing guard: fastify's own parser would
    // refuse an oversized body at this limit even if the hook were removed.
    for (const url of ['/api/v1/billing/mmg/agent-notification', '/api/v1/billing/mmg/inquiry']) {
      expect(app.hasRoute({ method: 'POST', url })).toBe(true);
      expect(routeBodyLimits.get(`POST ${url}`)).toBe(AGENT_CASH_MAX_RAW_BODY_BYTES);
    }
  });

  it('on a real socket, a chunked upload past the cap is answered 413 mid-upload — the upload is never taken in', async () => {
    // inject() cannot show this: the old code buffered a whole upload before
    // fastify's parser could 413 it, so the answer only came once the client
    // had sent everything. Here the client is WILLING to send 8 MB; the server
    // must answer long before that, while the client is still uploading, and
    // the client must receive that answer cleanly (no reset — the request
    // stream is drained and dropped, never destroyed). afterAll's app.close()
    // then proves the socket was released once the client hung up.
    await app.listen({ port: 0, host: '127.0.0.1' });
    const { port } = app.server.address() as AddressInfo;
    const BUDGET = 8 * 1024 * 1024;
    const chunk = Buffer.alloc(64 * 1024, 0x7b);

    const outcome = await new Promise<{ status: number; code: string | undefined; bytesWritten: number }>((resolve, reject) => {
      let bytesWritten = 0;
      let settled = false;
      const request = http.request(
        {
          host: '127.0.0.1',
          port,
          method: 'POST',
          path: '/api/v1/billing/mmg/agent-notification',
          headers: {
            'content-type': 'application/json',
            'transfer-encoding': 'chunked',
            'x-swift-timestamp': String(Date.now()),
            'x-swift-signature': 'irrelevant-the-size-guard-fires-first',
          },
        },
        (res) => {
          settled = true; // the server answered while the upload was still in flight
          let body = '';
          res.setEncoding('utf8');
          res.on('data', (piece: string) => { body += piece; });
          res.on('end', () => {
            let code: string | undefined;
            try { code = (JSON.parse(body) as { error?: { code?: string } }).error?.code; } catch { code = undefined; }
            resolve({ status: res.statusCode ?? 0, code, bytesWritten });
            request.destroy(); // a sane client stops uploading once it has its answer
          });
        },
      );
      request.on('error', (err) => {
        if (!settled) reject(err);
      });
      const pump = (): void => {
        if (settled || request.destroyed) return;
        if (bytesWritten >= BUDGET) {
          request.end();
          return;
        }
        bytesWritten += chunk.length;
        if (request.write(chunk)) setImmediate(pump);
        else request.once('drain', pump);
      };
      pump();
    });

    expect(outcome.status).toBe(413);
    expect(outcome.code).toBe('FST_ERR_CTP_BODY_TOO_LARGE');
    // Client side: the answer came MID-upload — before the client had written
    // everything it was willing to send. How far it got first depends on the
    // runner (kernel buffers, loop scheduling; a loaded CI box let it write
    // ~2.7 MB), so the bound is the whole budget, not a fraction of it: the old
    // code buffered every byte and could only answer once all 8 MB had been
    // sent and request.end() called, so it fails this bound every time.
    expect(outcome.bytesWritten).toBeLessThan(BUDGET);
    // Server side, timing-free: the capture decided within one socket read of
    // the 128 KB cap and retained nothing — the property that actually matters.
    expect(lastCapture?.url).toBe('/api/v1/billing/mmg/agent-notification');
    expect(lastCapture?.retained).toBeUndefined();
    expect(lastCapture?.seen).toBeGreaterThan(AGENT_CASH_MAX_RAW_BODY_BYTES);
    expect(lastCapture?.seen).toBeLessThanOrEqual(AGENT_CASH_MAX_RAW_BODY_BYTES + 64 * 1024);
  });
});
