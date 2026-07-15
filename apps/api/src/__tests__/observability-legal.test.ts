import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { registerErrorHandler } from '../middleware/error-handler';
import { observabilityPlugin } from '../plugins/observability';
import { legalRoutes } from '../modules/legal/legal.routes';

// ---------------------------------------------------------------------------
// /metrics is OFF by default (no METRICS_TOKEN ⇒ 404) and token-gated when on;
// the legal pages are public product content served as HTML.
// ---------------------------------------------------------------------------

let app: FastifyInstance;

beforeAll(async () => {
  delete process.env['METRICS_TOKEN'];
  delete process.env['SENTRY_DSN'];
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(observabilityPlugin);
  await app.register(legalRoutes, { prefix: '/legal' });
  await app.ready();
});

afterAll(async () => {
  delete process.env['METRICS_TOKEN'];
  await app.close();
});

describe('GET /metrics', () => {
  it('404s when METRICS_TOKEN is unset (safe default on a public API)', async () => {
    const res = await app.inject({ method: 'GET', url: '/metrics' });
    expect(res.statusCode).toBe(404);
  });

  it('401s a wrong token and serves Prometheus text to the right one', async () => {
    process.env['METRICS_TOKEN'] = 'metrics-secret';
    const bad = await app.inject({ method: 'GET', url: '/metrics', headers: { authorization: 'Bearer nope' } });
    expect(bad.statusCode).toBe(401);

    const ok = await app.inject({ method: 'GET', url: '/metrics', headers: { authorization: 'Bearer metrics-secret' } });
    expect(ok.statusCode).toBe(200);
    expect(ok.headers['content-type']).toContain('text/plain');
    expect(ok.body).toContain('swift_http_request_duration_seconds');
    expect(ok.body).toContain('process_cpu_user_seconds_total'); // default metrics on
    delete process.env['METRICS_TOKEN'];
  });
});

describe('legal pages', () => {
  it('serves the Terms of Service as public HTML', async () => {
    const res = await app.inject({ method: 'GET', url: '/legal/terms' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.body).toContain('Terms of Service');
    expect(res.body).toContain('Swift never holds');
  });

  it('serves the Privacy Policy as public HTML', async () => {
    const res = await app.inject({ method: 'GET', url: '/legal/privacy' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('Privacy Policy');
    expect(res.body).toContain('never sell your data');
  });
});
