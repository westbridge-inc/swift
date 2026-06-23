import type { FastifyInstance } from 'fastify';

/**
 * Treat an empty `application/json` body as `{}`.
 *
 * The mobile/admin axios clients always send `Content-Type: application/json`,
 * including on action POSTs that legitimately carry no body (go-online, accept,
 * handover, go-offline…). Without this, Fastify rejects them with
 * FST_ERR_CTP_EMPTY_JSON_BODY (400) — which silently broke every body-less POST.
 * Routes that DO require a body still validate it via Zod (an empty `{}` fails
 * their schema exactly as before), so this only relaxes the transport layer.
 */
export function registerEmptyJsonBodyParser(app: FastifyInstance): void {
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    const text = typeof body === 'string' ? body.trim() : '';
    if (!text) {
      done(null, {});
      return;
    }
    try {
      done(null, JSON.parse(text));
    } catch (err) {
      (err as { statusCode?: number }).statusCode = 400;
      done(err as Error, undefined);
    }
  });
}
