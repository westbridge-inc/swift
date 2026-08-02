import type { PrismaClient, AdCreative, AdMediaKind } from '@prisma/client';
import type { Server } from 'socket.io';
import { AppError, NotFoundError } from '../../utils/errors';
import { looksLikeImage } from '../../utils/images';
import { getStorageProvider } from '../../providers/storage/storage-provider';
import { AdsLifecycleService } from './lifecycle.service';
import { log } from '../../utils/logger';

// Creative upload + review (ads-platform spec §9/§10). Reconciliation: the spec
// asks for S3 signed-URL upload; the repo's proven, magic-byte-validated path
// is direct multipart (selfies, KYC docs, courier proofs), so ad creatives use
// the SAME uploader for consistency. Server enforces the §9.1 specs (mime,
// size, text lengths); images are review-ready immediately, videos start
// QUEUED for the transcode job (ffmpeg normalization is infra — the job marks
// READY). Review flows through the ONE campaign lifecycle: the last approval
// on a PENDING_REVIEW campaign schedules it.

export const CREATIVE_REJECT_REASONS = [
  'BLURRY_LOW_QUALITY', 'MISLEADING_CLAIM', 'WRONG_DIMENSIONS', 'TEXT_UNREADABLE',
  'RESTRICTED_CATEGORY', 'OFFENSIVE_CONTENT', 'LANDING_PAGE_BROKEN', 'LANDING_PAGE_MISMATCH',
  'COMPETITOR_PLATFORM', 'OTHER',
] as const;
export type CreativeRejectReason = (typeof CREATIVE_REJECT_REASONS)[number];

// §9.1 per-kind limits.
const IMAGE_MAX_BYTES = 500 * 1024;
const VIDEO_MAX_BYTES = 25 * 1024 * 1024;
const IMAGE_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const VIDEO_MIMES = new Set(['video/mp4']);

/** MP4 ftyp magic bytes (…ftyp at offset 4). Good enough to reject a
 *  mislabeled non-video; full codec/duration checks belong to the transcode
 *  probe (ffprobe), which runs in the job. */
export function looksLikeMp4(buffer: Buffer): boolean {
  return buffer.length > 12 && buffer.toString('ascii', 4, 8) === 'ftyp';
}

export interface CreativeText {
  headline?: string;
  body?: string;
  ctaLabel?: string;
}

export class CreativeService {
  private lifecycle: AdsLifecycleService;
  constructor(private prisma: PrismaClient, private io: Server) {
    this.lifecycle = new AdsLifecycleService(prisma, io);
  }

  /** Validate the §9.1 text specs for a placement tier (hero headline ≤60,
   *  others ≤40; body ≤90; cta ≤15). Pure so the route can pre-check too. */
  static validateText(tier: number, text: CreativeText): void {
    const headlineMax = tier === 1 ? 60 : 40;
    if (text.headline && text.headline.length > headlineMax) throw new AppError(400, 'HEADLINE_TOO_LONG', `Headline must be ≤${headlineMax} characters.`);
    if (text.body && text.body.length > 90) throw new AppError(400, 'BODY_TOO_LONG', 'Body must be ≤90 characters.');
    if (text.ctaLabel && text.ctaLabel.length > 15) throw new AppError(400, 'CTA_TOO_LONG', 'Call-to-action must be ≤15 characters.');
  }

  /** Upload a creative (direct multipart). Validates mime (magic-byte), size,
   *  and text; stores it; enters review PENDING. Only the owning advertiser's
   *  members reach here (checked at the route). */
  async upload(input: {
    campaignId: string;
    kind: AdMediaKind;
    buffer: Buffer;
    mime: string;
    filename: string;
    text: CreativeText;
  }): Promise<AdCreative> {
    const campaign = await this.prisma.adCampaign.findUnique({
      where: { id: input.campaignId },
      include: { placement: { select: { tier: true, mediaKind: true } } },
    });
    if (!campaign) throw new NotFoundError('AdCampaign', input.campaignId);
    if (campaign.status === 'COMPLETED' || campaign.status === 'CANCELLED' || campaign.status === 'REJECTED') {
      throw new AppError(409, 'CAMPAIGN_TERMINAL', 'This campaign can no longer take creatives.');
    }
    if (input.kind !== campaign.placement.mediaKind) {
      throw new AppError(400, 'WRONG_MEDIA_KIND', `This placement takes ${campaign.placement.mediaKind}, not ${input.kind}.`);
    }

    // Magic-byte mime sniff — never trust the declared content type (§9.2).
    if (input.kind === 'IMAGE') {
      if (!IMAGE_MIMES.has(input.mime) || !looksLikeImage(input.buffer)) throw new AppError(400, 'BAD_IMAGE', 'Upload a JPEG, PNG, or WebP image.');
      if (input.buffer.length > IMAGE_MAX_BYTES) throw new AppError(400, 'IMAGE_TOO_LARGE', 'Image must be ≤500 KB.');
    } else {
      if (!VIDEO_MIMES.has(input.mime) || !looksLikeMp4(input.buffer)) throw new AppError(400, 'BAD_VIDEO', 'Upload an MP4 (H.264 + AAC) video.');
      if (input.buffer.length > VIDEO_MAX_BYTES) throw new AppError(400, 'VIDEO_TOO_LARGE', 'Video must be ≤25 MB.');
    }
    CreativeService.validateText(campaign.placement.tier, input.text);

    const { url } = await getStorageProvider().upload({
      buffer: input.buffer,
      filename: input.filename,
      mimeType: input.mime,
      folder: `ads/${input.campaignId}`,
    });

    const creative = await this.prisma.adCreative.create({
      data: {
        campaignId: input.campaignId,
        kind: input.kind,
        fileUrl: url,
        headline: input.text.headline ?? null,
        body: input.text.body ?? null,
        ctaLabel: input.text.ctaLabel ?? null,
        // Images are review-ready; videos wait on the transcode job (§9.2).
        transcodeStatus: input.kind === 'VIDEO' ? 'QUEUED' : 'READY',
        status: 'PENDING',
      },
    });
    log().info({ creativeId: creative.id, campaignId: input.campaignId, kind: input.kind }, 'ad creative uploaded — PENDING review');
    // §10.4 advisory pre-screen — fire-and-forget. It annotates the review
    // queue; it NEVER blocks the upload and NEVER decides the review.
    void this.preScreen(creative.id, campaign.tenantId, {
      kind: input.kind,
      headline: input.text.headline ?? null,
      body: input.text.body ?? null,
      ctaLabel: input.text.ctaLabel ?? null,
      destinationType: campaign.destinationType,
      destinationValue: campaign.destinationValue,
    }).catch(() => {});
    return creative;
  }

  /** Run the advisory pre-screen and stamp the annotation. Advisory law: any
   *  failure here is swallowed — the creative simply carries no annotation. */
  async preScreen(
    creativeId: string,
    tenantId: string,
    input: { kind: 'IMAGE' | 'VIDEO'; headline: string | null; body: string | null; ctaLabel: string | null; destinationType: string | null; destinationValue: string | null },
  ): Promise<void> {
    const { getAdPreScreenProvider } = await import('../../providers/prescreen/ad-prescreen-provider');
    const provider = getAdPreScreenProvider();
    if (!provider) return; // kill switch (ADS_PRESCREEN_PROVIDER=off)
    const settings = await this.prisma.adsSettings.findUnique({ where: { tenantId }, select: { restrictedCategories: true } });
    const result = await provider.screen({
      ...input,
      restrictedCategories: (settings?.restrictedCategories ?? null) as Record<string, boolean> | null,
    });
    await this.prisma.adCreative.update({ where: { id: creativeId }, data: { preScreen: result as never } });
  }

  /** The transcode job's completion hook (§9.2): a normalized 720p H.264 +
   *  poster → READY. Kept as a service method so the (infra-gated) ffmpeg job
   *  just calls this; a dev/test path can call it directly. */
  async markTranscoded(creativeId: string, posterUrl: string): Promise<AdCreative> {
    return this.prisma.adCreative.update({ where: { id: creativeId }, data: { transcodeStatus: 'READY', posterUrl } });
  }

  // ── Review (§10) ─────────────────────────────────────────────────────────

  /** The AD_CREATIVE_REVIEW queue — PENDING creatives ready to review (videos
   *  only once transcoded), oldest first. */
  async queue(limit = 50) {
    return this.prisma.adCreative.findMany({
      where: { status: 'PENDING', transcodeStatus: 'READY' },
      orderBy: { createdAt: 'asc' },
      take: limit,
    });
  }

  /** §16 "review SLA at risk": reviewable (PENDING + READY — same filter as
   *  the queue) creatives sitting longer than `fraction` of the SLA window.
   *  The caller pages ops once per creative (redis once-key). */
  async reviewSlaAtRisk(slaHours: number, now = new Date(), fraction = 0.75) {
    const cutoff = new Date(now.getTime() - slaHours * fraction * 3_600_000);
    return this.prisma.adCreative.findMany({
      where: { status: 'PENDING', transcodeStatus: 'READY', createdAt: { lt: cutoff } },
      select: { id: true, campaignId: true, createdAt: true, campaign: { select: { name: true } } },
      orderBy: { createdAt: 'asc' },
      take: 100,
    });
  }

  /** Approve a creative. If it was the last PENDING one on a PENDING_REVIEW
   *  campaign, the campaign auto-schedules through the lifecycle. */
  async approve(creativeId: string, adminUserId: string): Promise<AdCreative> {
    const creative = await this.prisma.adCreative.findUnique({ where: { id: creativeId } });
    if (!creative) throw new NotFoundError('AdCreative', creativeId);
    if (creative.transcodeStatus !== 'READY') throw new AppError(409, 'NOT_READY', 'This creative is still processing.');
    const moved = await this.prisma.adCreative.updateMany({
      where: { id: creativeId, status: 'PENDING' },
      data: { status: 'APPROVED', reviewedByUserId: adminUserId, reviewedAt: new Date() },
    });
    if (moved.count === 0) throw new AppError(409, 'ALREADY_REVIEWED', 'This creative was already reviewed.');
    await this.audit(creative.campaignId, adminUserId, 'CREATIVE_APPROVE', creativeId);

    // all_creatives_approved (§6.1): every creative APPROVED, none PENDING.
    const pending = await this.prisma.adCreative.count({ where: { campaignId: creative.campaignId, status: 'PENDING' } });
    const approved = await this.prisma.adCreative.count({ where: { campaignId: creative.campaignId, status: 'APPROVED' } });
    if (pending === 0 && approved > 0) {
      const campaign = await this.prisma.adCampaign.findUnique({ where: { id: creative.campaignId }, select: { status: true } });
      if (campaign?.status === 'PENDING_REVIEW') {
        await this.lifecycle.transition(creative.campaignId, 'all_creatives_approved', adminUserId).catch((err) => log().error({ err, campaignId: creative.campaignId }, 'auto-schedule after approval failed'));
      }
    }
    return this.prisma.adCreative.findUniqueOrThrow({ where: { id: creativeId } });
  }

  /** Reject a creative with a structured reason (§10.3). Campaign stays
   *  PENDING_REVIEW (SLA clock keeps running); the advertiser re-uploads. */
  async reject(creativeId: string, adminUserId: string, reason: CreativeRejectReason, notes?: string): Promise<AdCreative> {
    if (reason === 'OTHER' && (!notes || notes.trim().length < 3)) {
      throw new AppError(400, 'NOTE_REQUIRED', 'A note is required for an "other" rejection.');
    }
    const creative = await this.prisma.adCreative.findUnique({ where: { id: creativeId } });
    if (!creative) throw new NotFoundError('AdCreative', creativeId);
    const moved = await this.prisma.adCreative.updateMany({
      where: { id: creativeId, status: 'PENDING' },
      data: { status: 'REJECTED', reviewNotes: `${reason}${notes ? `: ${notes}` : ''}`, reviewedByUserId: adminUserId, reviewedAt: new Date() },
    });
    if (moved.count === 0) throw new AppError(409, 'ALREADY_REVIEWED', 'This creative was already reviewed.');
    await this.audit(creative.campaignId, adminUserId, 'CREATIVE_REJECT', creativeId, reason);
    // Notify the advertiser with the specific reason + resubmit CTA.
    const owners = await this.prisma.advertiserMember.findMany({
      where: { advertiser: { campaigns: { some: { id: creative.campaignId } } }, role: 'OWNER' },
      select: { userId: true },
    });
    const { NotificationService } = await import('../notification/notification.service');
    const notifier = new NotificationService(this.prisma, this.io);
    for (const o of owners) {
      await notifier.send({ userId: o.userId, type: 'SYSTEM_ANNOUNCEMENT', title: 'Creative needs changes', body: `Your ad creative was not approved (${reason}). Edit and re-upload from your campaign.`, data: { kind: 'ad_creative_rejected', creativeId, reason } }).catch(() => {});
    }
    return this.prisma.adCreative.findUniqueOrThrow({ where: { id: creativeId } });
  }

  private async audit(campaignId: string, actorUserId: string, action: string, entityId: string, reason?: string) {
    const c = await this.prisma.adCampaign.findUnique({ where: { id: campaignId }, select: { tenantId: true } });
    await this.prisma.adsAuditLog.create({
      data: { tenantId: c?.tenantId ?? 'swift-default', actorUserId, action, entityType: 'AdCreative', entityId, reason: reason ?? null },
    }).catch(() => {});
  }
}
