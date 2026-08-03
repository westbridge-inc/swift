import type { FastifyInstance } from 'fastify';
import { classifyScan, normalizeShortCode } from './qr-codes';
import { QrService } from './qr.service';
import { buildScanEvent, enqueueScanEvent, startScanLog, stopScanLog } from './scan-log';

// ---------------------------------------------------------------------------
// The app-side twins of the public resolver (spec Part 6.2 / 8.2), mounted
// under /api/v1/public (authz-exempt by design, same as the storefront reads):
//
//   GET  /qr/:code          — JSON resolve for an in-app /s/ link: the SAME
//                             classify as /s/:code, minus the 302. vendorId
//                             only surfaces for a live storefront; dead codes
//                             reveal exactly what the web redirect would.
//   POST /qr/:code/app-open — the funnel report for OS-intercepted universal
//                             links (the web resolver never ran): files the
//                             APP_OPEN_ASSUMED event, fire-and-forget.
//
// Identical rate treatment to the resolver; responses are shape-identical for
// unknown vs malformed codes (no oracle).
// ---------------------------------------------------------------------------

const RATE = { max: 30, timeWindow: '1 minute' };

export async function qrPublicRoutes(app: FastifyInstance) {
  const qrService = new QrService(app.prisma);
  startScanLog(app.prisma);
  app.addHook('onClose', async () => { await stopScanLog(); });

  app.get<{ Params: { code: string } }>('/qr/:code', { config: { rateLimit: RATE } }, async (request) => {
    const code = normalizeShortCode(request.params.code);
    const qr = code ? await qrService.findByShortCode(code) : null;
    const verdict = classifyScan(qr, new Date(), await qrService.graceDays());
    const live = verdict === 'WEB_RENDER' && qr?.entity ? qr : null;
    return {
      success: true,
      data: {
        verdict,
        vendorId: live?.entityId ?? null,
        slug: live?.entity?.slug ?? null,
      },
    };
  });

  app.post<{ Params: { code: string } }>('/qr/:code/app-open', { config: { rateLimit: RATE } }, async (request) => {
    const code = normalizeShortCode(request.params.code);
    const qr = code ? await qrService.findByShortCode(code) : null;
    // Unknown codes acknowledge identically and log nothing — no oracle,
    // no junk rows. The event is garnish; the response never waits on it.
    if (qr) enqueueScanEvent(buildScanEvent(request, qr, 'APP_OPEN_ASSUMED'));
    return { success: true, data: { recorded: Boolean(qr) } };
  });
}
