import type { PrismaClient } from '@prisma/client';
import { Prisma } from '@prisma/client';
import { classifyScan } from './qr-codes';
import { QrService } from './qr.service';
import { enqueueScanEvent, hashScanIp, hashUa, parseUserAgent } from './scan-log';
import {
  ATTRIB_MAX_OPEN_PER_FP,
  ATTRIB_TTL_MINUTES,
  computeFpHash,
  parseInstallReferrer,
} from './attribution';

// ---------------------------------------------------------------------------
// Attribution service. Two laws rule everything here:
//   1. Precision over recall — 0 or ≥2 candidates means Home. The app NEVER
//      opens a guessed store (spec 4.3; same-café-Wi-Fi case included).
//   2. The claim is idempotent per installId via a permanent receipt row,
//      surviving the hourly purge of ephemeral fingerprint candidates.
// ---------------------------------------------------------------------------

export interface ClaimResult {
  destination: string | null;
  tenantHint: string | null;
  outcome: 'deterministic' | 'matched' | 'ambiguous' | 'none';
}

const isUniqueViolation = (e: unknown): e is Prisma.PrismaClientKnownRequestError =>
  e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002';

export class AttributionService {
  private qrService: QrService;
  constructor(private prisma: PrismaClient) {
    this.qrService = new QrService(this.prisma);
  }

  /** A code earns a deep-link destination only while a scan of it would land
   *  on the storefront (WEB_RENDER) — retired/dead codes attribute nothing. */
  private async destinationFor(code: string): Promise<{ path: string; qrCodeId: string; tenantId: string } | null> {
    const qr = await this.qrService.findByShortCode(code);
    if (!qr) return null;
    const verdict = classifyScan(qr, new Date(), await this.qrService.graceDays());
    if (verdict !== 'WEB_RENDER' || !qr.entity) return null;
    return { path: `/store/${qr.entity.slug}`, qrCodeId: qr.id, tenantId: qr.tenantId };
  }

  /** Web install-CTA tap: record an iOS candidate (server-computed fingerprint,
   *  capped per fp with oldest-out) and return the platform store URL. */
  async intent(
    shortCode: string,
    request: { ip: string; ua: string | undefined; isIos: boolean },
  ): Promise<{ created: boolean; destinationPath: string } | null> {
    const dest = await this.destinationFor(shortCode);
    if (!dest) return null;

    // Every install-CTA tap leaves a funnel artifact on the scan spine — this
    // is how Android taps (which write no candidate row) stay countable.
    const now0 = new Date();
    const { osFamily, deviceClass } = parseUserAgent(request.ua);
    enqueueScanEvent({
      tenantId: dest.tenantId,
      qrCodeId: dest.qrCodeId,
      occurredAt: now0,
      decision: 'INSTALL_TAP',
      src: 'web',
      osFamily,
      deviceClass,
      uaHash: request.ua ? hashUa(request.ua) : null,
      ipHash: request.ip ? hashScanIp(request.ip, now0) : null,
    });

    if (!request.isIos) return { created: false, destinationPath: dest.path };

    const fpHash = computeFpHash(request.ip, request.ua);
    const now = new Date();
    const open = await this.prisma.pendingAttribution.findMany({
      where: { fpHash, expiresAt: { gt: now }, claimedAt: null },
      orderBy: { createdAt: 'asc' },
    });
    if (open.length >= ATTRIB_MAX_OPEN_PER_FP) {
      await this.prisma.pendingAttribution.deleteMany({
        where: { id: { in: open.slice(0, open.length - ATTRIB_MAX_OPEN_PER_FP + 1).map((r) => r.id) } },
      });
    }
    await this.prisma.pendingAttribution.create({
      data: {
        tenantId: dest.tenantId,
        qrCodeId: dest.qrCodeId,
        destinationPath: dest.path,
        platform: 'ios',
        fpHash,
        expiresAt: new Date(now.getTime() + ATTRIB_TTL_MINUTES * 60_000),
      },
    });
    return { created: true, destinationPath: dest.path };
  }

  /** First-launch claim. Deterministic on Android referrer; single-candidate
   *  fingerprint match on iOS; receipt-idempotent per installId always. */
  async claim(
    installId: string,
    platform: string,
    referrer: string | undefined,
    request: { ip: string; ua: string | undefined },
  ): Promise<ClaimResult> {
    const existing = await this.prisma.attributionClaim.findUnique({ where: { installId } });
    if (existing) {
      return {
        destination: existing.destinationPath,
        tenantHint: existing.destinationPath ? existing.tenantId : null,
        outcome: existing.outcome as ClaimResult['outcome'],
      };
    }

    const resolved = await this.resolveClaim(installId, platform, referrer, request);
    try {
      await this.prisma.attributionClaim.create({
        data: {
          tenantId: resolved.tenantId ?? 'swift-default',
          installId,
          platform,
          qrCodeId: resolved.qrCodeId,
          destinationPath: resolved.destination,
          outcome: resolved.outcome,
        },
      });
    } catch (e) {
      if (!isUniqueViolation(e)) throw e;
      // Two concurrent claims for one installId: the receipt is the truth.
      const winner = await this.prisma.attributionClaim.findUniqueOrThrow({ where: { installId } });
      return {
        destination: winner.destinationPath,
        tenantHint: winner.destinationPath ? winner.tenantId : null,
        outcome: winner.outcome as ClaimResult['outcome'],
      };
    }
    return {
      destination: resolved.destination,
      tenantHint: resolved.destination ? (resolved.tenantId ?? null) : null,
      outcome: resolved.outcome,
    };
  }

  private async resolveClaim(
    installId: string,
    platform: string,
    referrer: string | undefined,
    request: { ip: string; ua: string | undefined },
  ): Promise<{ destination: string | null; tenantId: string | null; qrCodeId: string | null; outcome: ClaimResult['outcome'] }> {
    if (platform === 'android') {
      const parsed = referrer ? parseInstallReferrer(referrer) : null;
      const dest = parsed ? await this.destinationFor(parsed.code) : null;
      return dest
        ? { destination: dest.path, tenantId: dest.tenantId, qrCodeId: dest.qrCodeId, outcome: 'deterministic' }
        : { destination: null, tenantId: null, qrCodeId: null, outcome: 'none' };
    }

    // iOS: recompute the fingerprint from THIS request.
    const fpHash = computeFpHash(request.ip, request.ua);
    const candidates = await this.prisma.pendingAttribution.findMany({
      where: { fpHash, expiresAt: { gt: new Date() }, claimedAt: null },
    });
    if (candidates.length !== 1) {
      return { destination: null, tenantId: null, qrCodeId: null, outcome: candidates.length === 0 ? 'none' : 'ambiguous' };
    }
    const candidate = candidates[0]!;
    const won = await this.prisma.pendingAttribution.updateMany({
      where: { id: candidate.id, claimedAt: null }, // race guard
      data: { claimedAt: new Date(), claimedInstallId: installId },
    });
    return won.count === 1
      ? { destination: candidate.destinationPath, tenantId: candidate.tenantId, qrCodeId: candidate.qrCodeId, outcome: 'matched' }
      : { destination: null, tenantId: null, qrCodeId: null, outcome: 'none' };
  }

  /** Hourly job: fingerprints are ephemeral BY DESIGN (DPA) — expired rows
   *  hard-delete, claimed or not. Receipts carry the analytics forever. */
  async purgeExpired(): Promise<number> {
    const res = await this.prisma.pendingAttribution.deleteMany({ where: { expiresAt: { lt: new Date() } } });
    return res.count;
  }
}
