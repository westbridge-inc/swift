import type { FastifyInstance } from 'fastify';
import { classifyScan, normalizeShortCode, publicWebBase, redirectTargetFor, sanitizeTemplate } from './qr-codes';
import { QrService } from './qr.service';
import { buildScanEvent, enqueueScanEvent, startScanLog, stopScanLog } from './scan-log';

// ---------------------------------------------------------------------------
// GET /s/:code — the public short-link resolver, registered at the ROOT path
// (the printed URL is {APP_PUBLIC_URL}/s/{code}; in production the web domain
// proxies /s/* here — LAUNCH_BLOCKERS carries that deploy item). This is the
// most-scanned public URL Swift will have, so it gets auth-endpoint treatment:
// per-IP rate limit, uniform not-found behavior (malformed and unknown share
// one path — no enumeration oracle), server-constructed redirect targets only
// (zero open-redirect surface), and analytics that can never block or break
// the scan itself.
// ---------------------------------------------------------------------------

/** Spec key RATE_RESOLVER_PER_IP: 30/min. The global limiter already buckets
 *  anonymous traffic by proxy-resolved IP; this tightens the resolver. */
const RESOLVER_RATE = { max: 30, timeWindow: '1 minute' };

export async function qrResolverRoutes(app: FastifyInstance) {
  const qrService = new QrService(app.prisma);
  startScanLog(app.prisma);
  app.addHook('onClose', async () => { await stopScanLog(); });

  app.get<{ Params: { code: string }; Querystring: { t?: string; src?: string } }>(
    '/s/:code',
    { config: { rateLimit: RESOLVER_RATE } },
    async (request, reply) => {
      const code = normalizeShortCode(request.params.code);
      const qr = code ? await qrService.findByShortCode(code) : null;
      const graceDays = await qrService.graceDays();
      const verdict = classifyScan(qr, new Date(), graceDays);

      // Fire-and-forget: the redirect never waits on analytics.
      enqueueScanEvent(buildScanEvent(request, qr, verdict));

      const target = redirectTargetFor(verdict, qr, {
        base: publicWebBase(),
        template: sanitizeTemplate(request.query.t),
      });
      // Scans must always hit fresh lifecycle state — never a cached redirect.
      return reply.header('cache-control', 'no-store').redirect(target, 302);
    },
  );
}
