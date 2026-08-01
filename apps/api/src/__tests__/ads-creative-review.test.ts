import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import type { Server } from 'socket.io';
import { nanoid } from 'nanoid';
import { CreativeService } from '../modules/ads/creative.service';
import { AdsLifecycleService } from '../modules/ads/lifecycle.service';

// Ads Phase 3 — creative review + the campaign lifecycle machine (spec
// §6.1/§9/§10). "Done = an approved creative auto-goes LIVE at week start":
// here we prove the upload → review → auto-schedule spine and the transition
// table; the week_start cron rides Phase 3b.

const prisma = new PrismaClient({ datasources: { db: { url: process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift_test' } } });
const io = { to: () => ({ emit: () => {} }) } as unknown as Server;
const creatives = new CreativeService(prisma, io);
const lifecycle = new AdsLifecycleService(prisma, io);

const advertiserIds: string[] = [];
const placementIds: string[] = [];
const campaignIds: string[] = [];
const userIds: string[] = [];
const MON = new Date('2026-08-03T00:00:00Z');
// A minimal valid PNG (magic bytes + filler) under 500 KB.
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(128, 1)]);
// A minimal "MP4" (ftyp box at offset 4).
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0]), Buffer.from('ftypisom', 'ascii'), Buffer.alloc(64, 1)]);

beforeAll(async () => { await prisma.$connect(); });

afterAll(async () => {
  await prisma.adCreative.deleteMany({ where: { campaignId: { in: campaignIds } } });
  await prisma.adsAuditLog.deleteMany({ where: { entityType: { in: ['AdCreative', 'AdCampaign'] }, tenantId: 'swift-default', entityId: { in: [...campaignIds] } } });
  await prisma.adCampaign.deleteMany({ where: { id: { in: campaignIds } } });
  await prisma.advertiserMember.deleteMany({ where: { advertiserId: { in: advertiserIds } } });
  await prisma.advertiser.deleteMany({ where: { id: { in: advertiserIds } } });
  await prisma.adPlacement.deleteMany({ where: { id: { in: placementIds } } });
  await prisma.notification.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await prisma.$disconnect();
});

async function scaffold(opts: { placementMediaKind?: 'IMAGE' | 'VIDEO'; placementTier?: number; campaignStatus?: string } = {}) {
  const ownerUser = await prisma.user.create({ data: { phone: `+${592_830_000_000 + Math.floor(Math.random() * 160_000_000)}`, firstName: 'Cr', lastName: nanoid(4), roles: ['CUSTOMER'], activeRole: 'CUSTOMER', isPhoneVerified: true } });
  userIds.push(ownerUser.id);
  const a = await prisma.advertiser.create({ data: { companyName: `Co ${nanoid(6)}`, industry: 'RETAIL', contactName: 'C', contactEmail: 'c@x.gy', contactPhone: '+5926000000', createdByUserId: ownerUser.id, status: 'APPROVED' } });
  advertiserIds.push(a.id);
  await prisma.advertiserMember.create({ data: { advertiserId: a.id, userId: ownerUser.id, role: 'OWNER' } });
  const p = await prisma.adPlacement.create({ data: { key: `k-${nanoid(6)}`, name: 'P', tier: opts.placementTier ?? 3, mediaKind: opts.placementMediaKind ?? 'IMAGE', weeklyPrice: 5000, slotsPerWeek: 6 } });
  placementIds.push(p.id);
  const c = await prisma.adCampaign.create({ data: { advertiserId: a.id, placementId: p.id, name: 'C', cities: ['*'], startWeek: MON, endWeek: MON, status: (opts.campaignStatus ?? 'PENDING_REVIEW') as never } });
  campaignIds.push(c.id);
  return { ownerUser, advertiser: a, placement: p, campaign: c };
}

describe('§9 creative upload + validation', () => {
  it('accepts a valid image, rejects a mislabeled/oversized/wrong-kind upload', async () => {
    const { campaign } = await scaffold({ placementMediaKind: 'IMAGE', placementTier: 3 });
    const ok = await creatives.upload({ campaignId: campaign.id, kind: 'IMAGE', buffer: PNG, mime: 'image/png', filename: 'a.png', text: { headline: 'Fresh roti daily', ctaLabel: 'Order' } });
    expect(ok.status).toBe('PENDING');
    expect(ok.transcodeStatus).toBe('READY'); // images are review-ready

    // Not really an image.
    await expect(creatives.upload({ campaignId: campaign.id, kind: 'IMAGE', buffer: Buffer.from('#!/bin/sh'), mime: 'image/png', filename: 'x.png', text: {} })).rejects.toThrow(/image/i);
    // Oversized.
    await expect(creatives.upload({ campaignId: campaign.id, kind: 'IMAGE', buffer: Buffer.concat([PNG, Buffer.alloc(600 * 1024)]), mime: 'image/png', filename: 'big.png', text: {} })).rejects.toThrow(/500 KB/);
    // Wrong kind for the placement.
    await expect(creatives.upload({ campaignId: campaign.id, kind: 'VIDEO', buffer: MP4, mime: 'video/mp4', filename: 'v.mp4', text: {} })).rejects.toThrow(/takes IMAGE/);
    // Headline too long for a tier-3 placement (≤40).
    await expect(creatives.upload({ campaignId: campaign.id, kind: 'IMAGE', buffer: PNG, mime: 'image/png', filename: 'a.png', text: { headline: 'x'.repeat(41) } })).rejects.toThrow(/Headline/);
  });

  it('a video starts QUEUED and is not reviewable until transcoded', async () => {
    const { campaign } = await scaffold({ placementMediaKind: 'VIDEO', placementTier: 1 });
    const v = await creatives.upload({ campaignId: campaign.id, kind: 'VIDEO', buffer: MP4, mime: 'video/mp4', filename: 'ad.mp4', text: { headline: 'Watch our story' } });
    expect(v.transcodeStatus).toBe('QUEUED');
    await expect(creatives.approve(v.id, 'admin-1')).rejects.toThrow(/processing/i);
    // The transcode job completes → READY → reviewable.
    await creatives.markTranscoded(v.id, 'https://cdn/poster.jpg');
    const approved = await creatives.approve(v.id, 'admin-1');
    expect(approved.status).toBe('APPROVED');
  });
});

describe('§10 review → §6.1 auto-schedule', () => {
  it('the LAST approval on a PENDING_REVIEW campaign schedules it', async () => {
    const { campaign } = await scaffold();
    const c1 = await creatives.upload({ campaignId: campaign.id, kind: 'IMAGE', buffer: PNG, mime: 'image/png', filename: '1.png', text: {} });
    const c2 = await creatives.upload({ campaignId: campaign.id, kind: 'IMAGE', buffer: PNG, mime: 'image/png', filename: '2.png', text: {} });

    await creatives.approve(c1.id, 'admin-1');
    expect((await prisma.adCampaign.findUniqueOrThrow({ where: { id: campaign.id } })).status).toBe('PENDING_REVIEW'); // one still pending
    await creatives.approve(c2.id, 'admin-1');
    expect((await prisma.adCampaign.findUniqueOrThrow({ where: { id: campaign.id } })).status).toBe('SCHEDULED'); // auto-scheduled
  });

  it('rejecting keeps the campaign in review with a structured reason; OTHER needs a note', async () => {
    const { campaign, ownerUser } = await scaffold();
    const cr = await creatives.upload({ campaignId: campaign.id, kind: 'IMAGE', buffer: PNG, mime: 'image/png', filename: '1.png', text: {} });
    await expect(creatives.reject(cr.id, 'admin-1', 'OTHER')).rejects.toThrow(/note/i);
    const rejected = await creatives.reject(cr.id, 'admin-1', 'WRONG_DIMENSIONS');
    expect(rejected.status).toBe('REJECTED');
    expect(rejected.reviewNotes).toContain('WRONG_DIMENSIONS');
    expect((await prisma.adCampaign.findUniqueOrThrow({ where: { id: campaign.id } })).status).toBe('PENDING_REVIEW');
    expect(await prisma.notification.findFirst({ where: { userId: ownerUser.id, title: 'Creative needs changes' } })).not.toBeNull();
    // Already-reviewed guard.
    await expect(creatives.approve(cr.id, 'admin-1')).rejects.toThrow(/already reviewed/i);
  });
});

describe('§6.1 lifecycle transition table', () => {
  it('walks SCHEDULED → LIVE → PAUSED → LIVE → COMPLETED and audits each', async () => {
    const { campaign } = await scaffold({ campaignStatus: 'SCHEDULED' });
    expect((await lifecycle.transition(campaign.id, 'week_start', 'system:cron')).status).toBe('LIVE');
    expect((await lifecycle.transition(campaign.id, 'pause', 'owner')).status).toBe('PAUSED');
    expect((await lifecycle.transition(campaign.id, 'resume', 'owner')).status).toBe('LIVE');
    expect((await lifecycle.transition(campaign.id, 'week_end', 'system:cron')).status).toBe('COMPLETED');
    // Terminal — no further transitions.
    await expect(lifecycle.transition(campaign.id, 'pause', 'owner')).rejects.toThrow(/terminal/i);
    expect(await prisma.adsAuditLog.count({ where: { entityId: campaign.id, action: { startsWith: 'CAMPAIGN_' } } })).toBeGreaterThanOrEqual(4);
  });

  it('rejects an illegal move (pause a SCHEDULED campaign)', async () => {
    const { campaign } = await scaffold({ campaignStatus: 'SCHEDULED' });
    await expect(lifecycle.transition(campaign.id, 'pause', 'owner')).rejects.toThrow(/Cannot pause/);
  });

  it('kill works from any non-terminal state → REJECTED', async () => {
    const { campaign } = await scaffold({ campaignStatus: 'LIVE' });
    expect((await lifecycle.transition(campaign.id, 'kill', 'admin-1', 'Competitor platform ad')).status).toBe('REJECTED');
  });
});
