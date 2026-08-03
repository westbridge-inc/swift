import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { NotFoundError } from '../../utils/errors';
import { AttributionService } from './attribution.service';
import { appStoreUrl, playStoreUrlFor } from './attribution';
import { normalizeShortCode, sanitizeTemplate } from './qr-codes';
import { parseUserAgent, startScanLog, stopScanLog } from './scan-log';

// ---------------------------------------------------------------------------
// Public attribution endpoints (spec 4.3). Both are pre-auth by nature (the
// caller is a web visitor or a first-launch app with no session yet), so they
// get resolver-grade treatment: strict input shapes, per-IP rate limits, and
// server-derived everything — the client never supplies fingerprint parts,
// tenant ids, or redirect targets.
// ---------------------------------------------------------------------------

const intentSchema = z.object({
  shortCode: z.string().min(1).max(32),
  t: z.string().max(32).optional(),
});

const claimSchema = z.object({
  installId: z.string().trim().min(8).max(64),
  platform: z.enum(['ios', 'android']),
  referrer: z.string().max(2048).optional(),
});

export async function attributionRoutes(app: FastifyInstance) {
  const attribution = new AttributionService(app.prisma);
  // intent() writes INSTALL_TAP funnel events; both scan-log starters are
  // idempotent, so co-registration with the resolver plugin is safe.
  startScanLog(app.prisma);
  app.addHook('onClose', async () => { await stopScanLog(); });

  /** POST /intent — web install-CTA tap. Records an iOS candidate (fingerprint
   *  computed from THIS request) and returns the platform store URL. */
  app.post('/intent', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (request) => {
    const body = intentSchema.parse(request.body);
    const code = normalizeShortCode(body.shortCode);
    const template = sanitizeTemplate(body.t);
    const ua = request.headers['user-agent'];
    const uaStr = typeof ua === 'string' ? ua : undefined;
    const { osFamily } = parseUserAgent(uaStr);

    const result = code
      ? await attribution.intent(code, { ip: request.ip, ua: uaStr, isIos: osFamily === 'ios' })
      : null;
    if (!result || !code) throw new NotFoundError('QrCode');

    // The platform-correct store URL: Android carries the code through the
    // Play referrer (deterministic); iOS relies on the fingerprint just filed.
    const storeUrl = osFamily === 'android' ? playStoreUrlFor(code, template) : appStoreUrl();
    return { success: true, data: { storeUrl } };
  });

  /** POST /claim — called once by the app on true first launch, before any
   *  login exists. 0 or ≥2 candidates → destination null → the app opens Home. */
  app.post('/claim', { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (request) => {
    const body = claimSchema.parse(request.body);
    const ua = request.headers['user-agent'];
    const result = await attribution.claim(body.installId, body.platform, body.referrer, {
      ip: request.ip,
      ua: typeof ua === 'string' ? ua : undefined,
    });
    return { success: true, data: { destination: result.destination, tenantHint: result.tenantHint } };
  });
}
