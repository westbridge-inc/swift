import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { PrismaClient } from '@prisma/client';
import type { Server } from 'socket.io';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { adsRoutes } from '../modules/ads/ads.routes';
import { adminRoutes } from '../modules/admin/admin.routes';
import { registerErrorHandler } from '../middleware/error-handler';
import { CreativeService } from '../modules/ads/creative.service';
import { AdLinkService, AD_LINK_RECHECK_DAYS, AD_LINK_SOFT_GRACE_HOURS, AD_LINK_TICK_BUDGET_MS } from '../modules/ads/ad-link.service';
import { AdServingService } from '../modules/ads/serving.service';
import { AdsCronService } from '../modules/ads/cron.service';
import { AdCheckoutService } from '../modules/ads/checkout.service';
import { mondayOf } from '../modules/ads/ads-weeks';
import { LINK_PAUSE_PREFIX } from '../modules/ads/ad-link-policy';
import type { AdLinkHop } from '../modules/ads/ad-link-probe';
import { TEST_ADMIN_REASON } from './helpers/admin-reason';

// [ADS-ON · 4 Oct ruling, GUARDRAILS s.4] "Ad destinations need an allow-list plus human approval."
// Every test here goes through the real services and the real database; only the network hop is a fake.

const prisma = new PrismaClient({ datasources: { db: { url: process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift_test' } } });
const tenantId = 'swift-default';
const io = { to: () => ({ emit: () => {} }) } as unknown as Server;
const DAY = 86_400_000;
const page: AdLinkHop = { status: 200, location: null, contentType: 'text/html', contentDisposition: null };
const sends = (hop: AdLinkHop | Error) => vi.fn(async () => { if (hop instanceof Error) throw hop; return hop; });

let app: FastifyInstance;
const hosts: string[] = [];
const userIds: string[] = [];
const advertiserIds: string[] = [];
const placementIds: string[] = [];
const campaignIds: string[] = [];
const houseAdIds: string[] = [];
const phoneBase = 592_830_000_000 + Math.floor(Math.random() * 160_000_000);
let seq = 0;

const host = (word: string) => { const h = `${word}-${nanoid(8).toLowerCase().replace(/[^a-z0-9]/g, 'x')}.example.gy`; hosts.push(h); return h; };

async function user(roles: Array<'CUSTOMER' | 'ADMIN'>) {
  seq += 1;
  const u = await app.prisma.user.create({
    data: { phone: `+${phoneBase + seq}`, firstName: 'Link', lastName: `U${seq}`, roles, activeRole: roles[0]!, isPhoneVerified: true, ...(roles[0] === 'ADMIN' ? { admin: { create: { permissions: ['*'] } } } : {}) },
  });
  userIds.push(u.id);
  const token = app.jwt.sign({ userId: u.id, role: roles[0]!, jti: nanoid(8) });
  await app.prisma.session.create({ data: { userId: u.id, token, refreshToken: nanoid(48), authMethod: 'OTP', deviceId: 'lnk', deviceType: 'test', expiresAt: new Date(Date.now() + DAY) } });
  return { userId: u.id, token };
}
/** Invoice numbers count the rows, so a suite that deletes an invoice leaves a gap the next checkout collides
 *  with. Like the checkout suites, a test that issues an invoice leaves its fixtures in place. */
const keepFixtures = (owner: string, advertiserId: string, placementId: string, campaignId: string) => {
  for (const [list, id] of [[userIds, owner], [advertiserIds, advertiserId], [placementIds, placementId], [campaignIds, campaignId]] as const) list.splice(list.indexOf(id), 1);
};

async function advertiser(ownerUserId: string) {
  const a = await prisma.advertiser.create({ data: { tenantId, companyName: `Link Co ${nanoid(5)}`, industry: 'RETAIL', contactName: 'C', contactEmail: 'c@x.gy', contactPhone: '+5926000000', createdByUserId: ownerUserId, status: 'APPROVED' } });
  advertiserIds.push(a.id);
  await prisma.advertiserMember.create({ data: { advertiserId: a.id, userId: ownerUserId, role: 'OWNER', acceptedAt: new Date() } });
  return a;
}
async function placement() {
  const p = await prisma.adPlacement.create({ data: { tenantId, key: `home_top_card_${nanoid(6)}`, name: 'Card', tier: 3, mediaKind: 'IMAGE', weeklyPrice: 5000, slotsPerWeek: 1 } });
  placementIds.push(p.id);
  return p;
}
const week = () => mondayOf(new Date(), 'America/Guyana');

/** A campaign at review, its creative pending, on a link nobody has approved. */
async function atReview(link: { type: 'NONE' | 'URL' | 'DEEPLINK'; value?: string; host?: string }) {
  const owner = await user(['CUSTOMER']);
  const a = await advertiser(owner.userId);
  const p = await placement();
  const c = await prisma.adCampaign.create({
    data: { tenantId, advertiserId: a.id, placementId: p.id, name: 'Link', cities: ['*'], startWeek: new Date(week().getTime() + 14 * DAY), endWeek: new Date(week().getTime() + 14 * DAY), status: 'PENDING_REVIEW', destinationType: link.type, destinationValue: link.value ?? null, destinationHost: link.host ?? null },
  });
  campaignIds.push(c.id);
  const creative = await prisma.adCreative.create({ data: { campaignId: c.id, kind: 'IMAGE', fileUrl: `https://cdn.example/${nanoid(6)}.png`, status: 'PENDING', transcodeStatus: 'READY' } });
  return { owner, advertiser: a, placement: p, campaign: c, creative };
}

/** A campaign live this week with an approved link. */
async function live(link: { value: string; host: string; checkedDaysAgo?: number; status?: 'LIVE' | 'SCHEDULED' }) {
  const owner = await user(['CUSTOMER']);
  const a = await advertiser(owner.userId);
  const p = await placement();
  const checkedAt = new Date(Date.now() - (link.checkedDaysAgo ?? 0) * DAY);
  const c = await prisma.adCampaign.create({
    data: {
      tenantId, advertiserId: a.id, placementId: p.id, name: 'Live link', cities: ['*'], startWeek: week(), endWeek: week(), status: link.status ?? 'LIVE',
      destinationType: 'URL', destinationValue: link.value, destinationHost: link.host, destinationApprovedByUserId: owner.userId, destinationApprovedAt: checkedAt, destinationCheckedAt: checkedAt,
    },
  });
  campaignIds.push(c.id);
  await prisma.adCreative.create({ data: { campaignId: c.id, kind: 'IMAGE', fileUrl: `https://cdn.example/${nanoid(6)}.png`, headline: 'Live', status: 'APPROVED', transcodeStatus: 'READY' } });
  await prisma.adBooking.create({ data: { campaignId: c.id, placementId: p.id, city: '*', weekStart: week(), amount: 5000, status: 'CONFIRMED' } });
  return { owner, advertiser: a, placement: p, campaign: c };
}
const allow = (h: string, status: 'APPROVED' | 'PENDING' | 'REJECTED' = 'APPROVED') =>
  prisma.adLinkDomain.upsert({ where: { tenantId_host: { tenantId, host: h } }, create: { tenantId, host: h, status }, update: { status } });
const services = (hop: AdLinkHop | Error = page) => {
  const creatives = new CreativeService(prisma, io);
  creatives.links.hop = sends(hop);
  return creatives;
};
const serve = (key: string) => new AdServingService(prisma).serve({ tenantId, city: 'Georgetown', sessionId: nanoid(8), userId: null, keys: [key] });
const notices = async (userId: string) => prisma.notification.findMany({ where: { userId } });

beforeAll(async () => {
  vi.stubEnv('ADS_ENABLED', '1');
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  await app.register(adsRoutes, { prefix: '/api/v1/ads' });
  await app.register(adminRoutes, { prefix: '/api/v1/admin' });
  await app.ready();
});

afterAll(async () => {
  vi.unstubAllEnvs();
  await prisma.adBooking.deleteMany({ where: { campaignId: { in: campaignIds } } });
  await prisma.adInventoryWeek.deleteMany({ where: { placementId: { in: placementIds } } });
  await prisma.adCreative.deleteMany({ where: { campaignId: { in: campaignIds } } });
  await prisma.adsAuditLog.deleteMany({ where: { entityId: { in: [...campaignIds, ...houseAdIds] } } });
  await prisma.adCampaign.deleteMany({ where: { id: { in: campaignIds } } });
  await prisma.houseAd.deleteMany({ where: { id: { in: houseAdIds } } });
  await prisma.adLinkDomain.deleteMany({ where: { host: { in: hosts } } });
  await prisma.advertiserMember.deleteMany({ where: { advertiserId: { in: advertiserIds } } });
  await prisma.advertiser.deleteMany({ where: { id: { in: advertiserIds } } });
  await prisma.adPlacement.deleteMany({ where: { id: { in: placementIds } } });
  await prisma.notification.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.session.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.admin.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await app.close();
  await prisma.$disconnect();
});

describe('an advertiser names a link', () => {
  const draft = async (destination: Record<string, string>) => {
    const owner = await user(['CUSTOMER']);
    const a = await advertiser(owner.userId);
    const p = await placement();
    const res = await app.inject({
      method: 'POST', url: '/api/v1/ads/campaigns', headers: { authorization: `Bearer ${owner.token}`, 'content-type': 'application/json' },
      payload: { advertiserId: a.id, placementId: p.id, name: 'Draft', startWeek: '2027-03-01', endWeek: '2027-03-01', ...destination },
    });
    if (res.statusCode === 200) campaignIds.push(res.json().data.id as string);
    return res;
  };

  it.each([
    ['http://example.gy', 'HTTPS_REQUIRED'],
    ['javascript:alert(1)', 'HTTPS_REQUIRED'],
    ['https://bit.ly/abc', 'URL_SHORTENER'],
    ['https://example.gy/app.apk', 'FILE_DOWNLOAD'],
    ['https://192.0.2.1/', 'IP_OR_LOCAL_HOST'],
  ])('%s is refused at the draft: %s', async (destinationValue, code) => {
    const res = await draft({ destinationType: 'URL', destinationValue });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe(code);
  });

  it('a deep link that is not a store is refused at the draft', async () => {
    const res = await draft({ destinationType: 'DEEPLINK', destinationValue: 'swift://pay/mmg/return' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('NOT_A_SWIFT_LINK');
  });

  it('the draft keeps the parsed link and queues nothing: only paying puts a new website in front of a person', async () => {
    const h = host('first');
    const res = await draft({ destinationType: 'URL', destinationValue: `https://WWW.${h}/Offer` });
    expect(res.statusCode).toBe(200);
    const row = await prisma.adCampaign.findUniqueOrThrow({ where: { id: res.json().data.id } });
    expect(row.destinationValue).toBe(`https://www.${h}/Offer`);
    expect(row.destinationHost).toBe(h);
    expect(row.destinationApprovedAt).toBeNull();
    expect(await prisma.adLinkDomain.count({ where: { tenantId, host: h } })).toBe(0);
  });

  it('a second ad on a website already decided never changes the decision', async () => {
    const h = host('kept');
    await allow(h);
    expect((await draft({ destinationType: 'URL', destinationValue: `https://${h}/a` })).statusCode).toBe(200);
    expect((await prisma.adLinkDomain.findFirstOrThrow({ where: { host: h } })).status).toBe('APPROVED');
  });

  it('a website a person refused stops at the draft', async () => {
    const h = host('refused');
    await allow(h, 'REJECTED');
    const res = await draft({ destinationType: 'URL', destinationValue: `https://${h}/a` });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('AD_LINK_DOMAIN_REFUSED');
  });

  it('no link is still fine, and a stray value with type NONE is not kept', async () => {
    const res = await draft({ destinationValue: 'https://example.gy' });
    expect(res.statusCode).toBe(200);
    const row = await prisma.adCampaign.findUniqueOrThrow({ where: { id: res.json().data.id } });
    expect([row.destinationType, row.destinationValue]).toEqual(['NONE', null]);
  });
});

describe('human approval at review', () => {
  it('the queue shows the reviewer the link, its website and where that website stands', async () => {
    const h = host('shown');
    const { creative } = await atReview({ type: 'URL', value: `https://${h}/deal`, host: h });
    await allow(h, 'PENDING');
    const rows = await services().queue(500);
    const row = rows.find((r) => r.id === creative.id)!;
    expect(row.link).toMatchObject({ kind: 'EXTERNAL', value: `https://${h}/deal`, host: h, domainStatus: 'PENDING', refusal: null });
    expect(row.link?.domainId).toBeTruthy();
    expect(row.advertiserName).toMatch(/^Link Co /);
  });

  it('an old link the policy refuses reaches the reviewer as words, never as something to click', async () => {
    const { creative } = await atReview({ type: 'URL', value: 'javascript:alert(1)' });
    const rows = await services().queue(500);
    expect(rows.find((r) => r.id === creative.id)?.link).toMatchObject({ kind: 'REFUSED', host: null });
  });

  it('an ad on a website not yet approved cannot be approved: the person decides the website first', async () => {
    const h = host('pending');
    const { creative, campaign } = await atReview({ type: 'URL', value: `https://${h}/a`, host: h });
    const creatives = services();
    await expect(creatives.approve(creative.id, 'admin-1')).rejects.toMatchObject({ code: 'AD_LINK_DOMAIN_NOT_APPROVED' });
    expect((await prisma.adCreative.findUniqueOrThrow({ where: { id: creative.id } })).status).toBe('PENDING');
    expect((await prisma.adCampaign.findUniqueOrThrow({ where: { id: campaign.id } })).status).toBe('PENDING_REVIEW');
    expect(creatives.links.hop).not.toHaveBeenCalled();
    expect((await prisma.adLinkDomain.findFirstOrThrow({ where: { host: h } })).status).toBe('PENDING');
  });

  it('approval walks the redirects, and stamps who and when in the same commit as the ad', async () => {
    const h = host('good');
    await allow(h);
    const { creative, campaign } = await atReview({ type: 'URL', value: `https://${h}/a`, host: h });
    const creatives = services();
    await creatives.approve(creative.id, 'admin-7');
    expect(creatives.links.hop).toHaveBeenCalledWith(`https://${h}/a`);
    const row = await prisma.adCampaign.findUniqueOrThrow({ where: { id: campaign.id } });
    expect(row.status).toBe('SCHEDULED');
    expect(row.destinationApprovedByUserId).toBe('admin-7');
    expect(row.destinationApprovedAt).toBeInstanceOf(Date);
    expect(row.destinationCheckedAt).toBeInstanceOf(Date);
    const audit = await prisma.adsAuditLog.findFirstOrThrow({ where: { entityId: campaign.id, action: 'CAMPAIGN_LINK_APPROVE' } });
    expect([audit.actorUserId, audit.reason]).toEqual(['admin-7', `https://${h}/a`]);
  });

  it.each([
    ['leaves the domain', { status: 302, location: 'https://evil.example/x', contentType: null, contentDisposition: null }],
    ['is a dead page', { ...page, status: 404 }],
    ['does not answer', new Error('timeout')],
    ['downloads a file', { ...page, contentType: 'application/vnd.android.package-archive' }],
  ])('a link that %s stops the approval: nothing moves, nothing is stamped', async (_w, hop) => {
    const h = host('bad');
    await allow(h);
    const { creative, campaign } = await atReview({ type: 'URL', value: `https://${h}/a`, host: h });
    await expect(services(hop as AdLinkHop | Error).approve(creative.id, 'admin-1')).rejects.toMatchObject({ code: 'AD_LINK_CHECK_FAILED' });
    expect((await prisma.adCreative.findUniqueOrThrow({ where: { id: creative.id } })).status).toBe('PENDING');
    const row = await prisma.adCampaign.findUniqueOrThrow({ where: { id: campaign.id } });
    expect([row.status, row.destinationApprovedAt, row.destinationApprovedByUserId]).toEqual(['PENDING_REVIEW', null, null]);
  });

  it('an app store link has no allow-list row: approving the ad is the person checking it is the advertiser\'s own app', async () => {
    const value = `https://play.google.com/store/apps/details?id=gy.link${nanoid(5).replace(/[^a-zA-Z0-9]/g, 'x')}.app`;
    const { creative, campaign } = await atReview({ type: 'URL', value, host: 'play.google.com' });
    const creatives = services();
    const rows = await creatives.queue(500);
    expect(rows.find((r) => r.id === creative.id)?.link).toMatchObject({ kind: 'APP_STORE', value, host: 'play.google.com', domainId: null });
    await creatives.approve(creative.id, 'admin-2');
    expect((await prisma.adCampaign.findUniqueOrThrow({ where: { id: campaign.id } })).destinationApprovedByUserId).toBe('admin-2');
    expect(await prisma.adLinkDomain.count({ where: { host: 'play.google.com' } })).toBe(0);
  });

  it('a link inside Swift walks nothing, and is still approved by a person', async () => {
    const { creative, campaign } = await atReview({ type: 'DEEPLINK', value: 'swift://store/a-store' });
    const creatives = services();
    await creatives.approve(creative.id, 'admin-3');
    expect(creatives.links.hop).not.toHaveBeenCalled();
    expect((await prisma.adCampaign.findUniqueOrThrow({ where: { id: campaign.id } })).destinationApprovedByUserId).toBe('admin-3');
  });

  it('an ad with no link is unchanged by all of this', async () => {
    const { creative, campaign } = await atReview({ type: 'NONE' });
    const creatives = services();
    await creatives.approve(creative.id, 'admin-4');
    const row = await prisma.adCampaign.findUniqueOrThrow({ where: { id: campaign.id } });
    expect([row.status, row.destinationApprovedAt]).toEqual(['SCHEDULED', null]);
  });

  it('a second creative on an approved link does not walk it again, but the website must still be on the list', async () => {
    const h = host('second');
    await allow(h);
    const { creative, campaign } = await atReview({ type: 'URL', value: `https://${h}/a`, host: h });
    const first = services();
    await first.approve(creative.id, 'admin-5');
    await prisma.adCampaign.update({ where: { id: campaign.id }, data: { status: 'PENDING_REVIEW' } });
    const next = await prisma.adCreative.create({ data: { campaignId: campaign.id, kind: 'IMAGE', fileUrl: 'https://cdn.example/2.png', status: 'PENDING', transcodeStatus: 'READY' } });
    await allow(h, 'REJECTED');
    await expect(services().approve(next.id, 'admin-5')).rejects.toMatchObject({ code: 'AD_LINK_DOMAIN_NOT_APPROVED' });
    await allow(h);
    const again = services();
    await again.approve(next.id, 'admin-5');
    expect(again.links.hop).not.toHaveBeenCalled();
  });
});

describe('the allow-list', () => {
  it('only a person moves a website: approve records who and when, with the reason on the audit trail', async () => {
    const h = host('person');
    const domain = await allow(h, 'PENDING');
    const admin = await user(['ADMIN']);
    const res = await app.inject({ method: 'PUT', url: `/api/v1/admin/ads/link-domains/${domain.id}/approve`, headers: { authorization: `Bearer ${admin.token}`, 'content-type': 'application/json', 'x-swift-reason': TEST_ADMIN_REASON }, payload: {} });
    expect(res.statusCode).toBe(200);
    const row = await prisma.adLinkDomain.findUniqueOrThrow({ where: { id: domain.id } });
    expect([row.status, row.reviewedByUserId]).toEqual(['APPROVED', admin.userId]);
    expect(row.reviewedAt).toBeInstanceOf(Date);
    expect(await prisma.adsAuditLog.count({ where: { entityId: domain.id, action: 'LINK_DOMAIN_APPROVE', actorUserId: admin.userId } })).toBe(1);
    const list = await app.inject({ method: 'GET', url: '/api/v1/admin/ads/link-domains?status=APPROVED', headers: { authorization: `Bearer ${admin.token}` } });
    const listed = (list.json().data as Array<{ host: string; reviewedByName: string | null }>).find((d) => d.host === h);
    expect(listed?.reviewedByName).toMatch(/^Link U/);
  });

  it('allowing a website states why, like every consequential decision', async () => {
    const domain = await allow(host('why'), 'PENDING');
    const admin = await user(['ADMIN']);
    const res = await app.inject({ method: 'PUT', url: `/api/v1/admin/ads/link-domains/${domain.id}/approve`, headers: { authorization: `Bearer ${admin.token}`, 'content-type': 'application/json' }, payload: {} });
    expect(res.statusCode).toBe(400);
    expect((await prisma.adLinkDomain.findUniqueOrThrow({ where: { id: domain.id } })).status).toBe('PENDING');
  });

  it('a customer cannot reach the list, nor owe a decision', async () => {
    const domain = await allow(host('wall'), 'PENDING');
    const customer = await user(['CUSTOMER']);
    const res = await app.inject({ method: 'PUT', url: `/api/v1/admin/ads/link-domains/${domain.id}/approve`, headers: { authorization: `Bearer ${customer.token}`, 'content-type': 'application/json', 'x-swift-reason': TEST_ADMIN_REASON }, payload: {} });
    expect(res.statusCode).toBe(403);
    expect((await prisma.adLinkDomain.findUniqueOrThrow({ where: { id: domain.id } })).status).toBe('PENDING');
  });

  it('a decision cannot be taken twice', async () => {
    const domain = await allow(host('twice'), 'PENDING');
    const links = new AdLinkService(prisma, io);
    await links.approveDomain(domain.id, 'admin-1');
    await expect(links.approveDomain(domain.id, 'admin-2')).rejects.toMatchObject({ code: 'ALREADY_REVIEWED' });
    expect((await prisma.adLinkDomain.findUniqueOrThrow({ where: { id: domain.id } })).reviewedByUserId).toBe('admin-1');
  });

  it('refusing an approved website stops what links to it at once: the campaign pauses with a notice, the house ad goes down', async () => {
    const h = host('revoke');
    const domain = await allow(h);
    const { campaign, owner, placement: p } = await live({ value: `https://${h}/a`, host: h });
    const house = await prisma.houseAd.create({ data: { tenantId, placementId: p.id, kind: 'IMAGE', fileUrl: 'https://cdn.example/h.png', destinationType: 'URL', destinationValue: `https://${h}/h`, destinationHost: h, destinationApprovedAt: new Date(), destinationCheckedAt: new Date() } });
    houseAdIds.push(house.id);
    await new AdLinkService(prisma, io).rejectDomain(domain.id, 'admin-1', 'This website now sells a banned item');
    const row = await prisma.adCampaign.findUniqueOrThrow({ where: { id: campaign.id } });
    expect(row.status).toBe('PAUSED');
    expect(row.statusReason?.startsWith(LINK_PAUSE_PREFIX)).toBe(true);
    expect((await prisma.houseAd.findUniqueOrThrow({ where: { id: house.id } })).active).toBe(false);
    const told = await notices(owner.userId);
    expect(told.map((n) => (n.data as { kind?: string }).kind)).toContain('ad_campaign_paused');
    expect(told.map((n) => n.title).join()).toContain('check your ad link');
  });
});

describe('the serve gate: nothing reaches a phone without it', () => {
  it('a live campaign on an approved link on an approved website serves', async () => {
    const h = host('serves');
    await allow(h);
    const { placement: p } = await live({ value: `https://${h}/a`, host: h });
    const out = await serve(p.key);
    expect(out.placements[p.key]?.items[0]?.destination).toEqual({ type: 'URL', value: `https://${h}/a` });
  });

  it('a link no person approved never serves, whatever else is true of it', async () => {
    const h = host('unstamped');
    await allow(h);
    const { campaign, placement: p } = await live({ value: `https://${h}/a`, host: h });
    await prisma.adCampaign.update({ where: { id: campaign.id }, data: { destinationApprovedAt: null } });
    expect((await serve(p.key)).placements[p.key]?.items).toEqual([]);
  });

  it('a website off the list never serves, approved link or not', async () => {
    const h = host('off-list');
    const { placement: p } = await live({ value: `https://${h}/a`, host: h });
    expect((await serve(p.key)).placements[p.key]?.items).toEqual([]);
    await allow(h, 'REJECTED');
    AdServingService.invalidateTenant(tenantId);
    expect((await serve(p.key)).placements[p.key]?.items).toEqual([]);
  });

  it('an old row with a link the policy refuses never serves, even stamped', async () => {
    const { campaign, placement: p } = await live({ value: 'https://placeholder.example.gy/', host: 'placeholder.example.gy' });
    await prisma.adCampaign.update({ where: { id: campaign.id }, data: { destinationValue: 'javascript:alert(1)' } });
    expect((await serve(p.key)).placements[p.key]?.items).toEqual([]);
  });

  it('a house ad meets the same gate', async () => {
    const h = host('house');
    const p = await placement();
    const make = async (data: Record<string, unknown>) => {
      const row = await prisma.houseAd.create({ data: { tenantId, placementId: p.id, kind: 'IMAGE', fileUrl: 'https://cdn.example/h.png', ...data } });
      houseAdIds.push(row.id);
      return row;
    };
    await make({ destinationType: 'URL', destinationValue: `https://${h}/raw` });
    await make({ destinationType: 'DEEPLINK', destinationValue: 'tel:+5926000000', destinationApprovedAt: new Date() });
    expect((await serve(p.key)).placements[p.key]?.items).toEqual([]);
    await allow(h);
    await make({ destinationType: 'URL', destinationValue: `https://${h}/ok`, destinationHost: h, destinationApprovedAt: new Date() });
    expect((await serve(p.key)).placements[p.key]?.items.map((i) => i.destination.value)).toEqual([`https://${h}/ok`]);
    const none = await placement();
    const plain = await prisma.houseAd.create({ data: { tenantId, placementId: none.id, kind: 'IMAGE', fileUrl: 'https://cdn.example/h.png' } });
    houseAdIds.push(plain.id);
    expect((await serve(none.key)).placements[none.key]?.items.map((i) => i.destination)).toEqual([{ type: 'NONE', value: null }]);
  });
});

describe('house ads saved by an operator', () => {
  it('the same refusals as a paid ad, and a website not on the list waits for a decision', async () => {
    const links = new AdLinkService(prisma, io);
    links.hop = sends(page);
    await expect(links.houseLink(tenantId, 'URL', 'https://bit.ly/x', 'admin-1')).rejects.toMatchObject({ code: 'URL_SHORTENER' });
    await expect(links.houseLink(tenantId, 'DEEPLINK', 'tel:+5926000000', 'admin-1')).rejects.toMatchObject({ code: 'NOT_A_SWIFT_LINK' });
    const h = host('housewait');
    await expect(links.houseLink(tenantId, 'URL', `https://${h}/`, 'admin-1')).rejects.toMatchObject({ code: 'AD_LINK_DOMAIN_NOT_APPROVED' });
    expect((await prisma.adLinkDomain.findFirstOrThrow({ where: { host: h } })).status).toBe('PENDING');
  });

  it('the redirect walk runs, and the operator who saved it is the person on record', async () => {
    const h = host('housegood');
    await allow(h);
    const links = new AdLinkService(prisma, io);
    links.hop = sends(page);
    expect(await links.houseLink(tenantId, 'URL', `https://${h}/`, 'admin-9')).toMatchObject({ destinationType: 'URL', destinationValue: `https://${h}/`, destinationHost: h, destinationApprovedByUserId: 'admin-9' });
    links.hop = sends({ ...page, status: 404 });
    await expect(links.houseLink(tenantId, 'URL', `https://${h}/`, 'admin-9')).rejects.toMatchObject({ code: 'AD_LINK_CHECK_FAILED' });
  });

  it('the update route cannot be used to swap in an unchecked link, or bring a house ad back without the check', async () => {
    const admin = await user(['ADMIN']);
    const p = await placement();
    const h = host('houseput');
    const row = await prisma.houseAd.create({ data: { tenantId, placementId: p.id, kind: 'IMAGE', fileUrl: 'https://cdn.example/h.png', active: false, destinationType: 'URL', destinationValue: 'https://bit.ly/stale' } });
    houseAdIds.push(row.id);
    const put = (payload: Record<string, unknown>) => app.inject({ method: 'PUT', url: `/api/v1/admin/ads/house/${row.id}`, headers: { authorization: `Bearer ${admin.token}`, 'content-type': 'application/json' }, payload });
    expect((await put({ destinationValue: 'javascript:alert(1)' })).statusCode).toBe(400);
    expect((await put({ destinationValue: `https://${h}/` })).json().error.code).toBe('AD_LINK_DOMAIN_NOT_APPROVED');
    expect((await put({ active: true })).json().error.code).toBe('URL_SHORTENER');
    const after = await prisma.houseAd.findUniqueOrThrow({ where: { id: row.id } });
    expect([after.active, after.destinationValue]).toEqual([false, 'https://bit.ly/stale']);
    expect((await put({ sort: 7 })).statusCode).toBe(200);
  });
});

describe('the weekly re-check', () => {
  const links = (hop: AdLinkHop | Error) => { const s = new AdLinkService(prisma, io); s.hop = sends(hop); return s; };
  const dayAfterDue = AD_LINK_RECHECK_DAYS + 1;

  it('a link inside its week is left alone', async () => {
    const h = host('fresh');
    await allow(h);
    const { campaign } = await live({ value: `https://${h}/a`, host: h, checkedDaysAgo: AD_LINK_RECHECK_DAYS - 1 });
    const s = links(new Error('must not be called'));
    expect(await s.recheckDue(new Date(), { campaignIds: [campaign.id], houseAdIds: [] })).toEqual({ checked: 0, stopped: 0 });
    expect(s.hop).not.toHaveBeenCalled();
  });

  it('a link that still passes gets a new date and keeps running', async () => {
    const h = host('passes');
    await allow(h);
    const { campaign } = await live({ value: `https://${h}/a`, host: h, checkedDaysAgo: dayAfterDue });
    const now = new Date();
    expect(await links(page).recheckDue(now, { campaignIds: [campaign.id], houseAdIds: [] })).toEqual({ checked: 1, stopped: 0 });
    const row = await prisma.adCampaign.findUniqueOrThrow({ where: { id: campaign.id } });
    expect([row.status, row.destinationCheckedAt]).toEqual(['LIVE', now]);
  });

  it.each([
    ['LIVE'],
    ['SCHEDULED'],
  ] as const)('a %s campaign whose link now leaves the domain pauses, with a notice saying why', async (status) => {
    const h = host('left');
    await allow(h);
    const { campaign, owner } = await live({ value: `https://${h}/a`, host: h, checkedDaysAgo: dayAfterDue, status });
    expect(await links({ status: 302, location: 'https://evil.example/', contentType: null, contentDisposition: null }).recheckDue(new Date(), { campaignIds: [campaign.id], houseAdIds: [] })).toEqual({ checked: 1, stopped: 1 });
    const row = await prisma.adCampaign.findUniqueOrThrow({ where: { id: campaign.id } });
    expect(row.status).toBe('PAUSED');
    expect(row.statusReason).toBe(`${LINK_PAUSE_PREFIX}it redirects away from the approved website`);
    const told = await notices(owner.userId);
    expect(told.map((n) => n.body).join()).toContain('it redirects away from the approved website');
    expect(await prisma.adsAuditLog.count({ where: { entityId: campaign.id, action: 'CAMPAIGN_LINK_CHECK_FAILED' } })).toBe(1);
  });

  it('a website that stopped being approved pauses without walking it', async () => {
    const h = host('dropped');
    await allow(h, 'REJECTED');
    const { campaign } = await live({ value: `https://${h}/a`, host: h, checkedDaysAgo: dayAfterDue });
    const s = links(page);
    expect(await s.recheckDue(new Date(), { campaignIds: [campaign.id], houseAdIds: [] })).toEqual({ checked: 1, stopped: 1 });
    expect(s.hop).not.toHaveBeenCalled();
  });

  it('a site that did not answer gets its grace, then pauses', async () => {
    const h = host('slow');
    await allow(h);
    const { campaign } = await live({ value: `https://${h}/a`, host: h, checkedDaysAgo: AD_LINK_RECHECK_DAYS });
    const lastPassed = (await prisma.adCampaign.findUniqueOrThrow({ where: { id: campaign.id } })).destinationCheckedAt as Date;
    const down = links(new Error('timeout'));
    const scope = { campaignIds: [campaign.id], houseAdIds: [] };
    const inGrace = new Date(lastPassed.getTime() + AD_LINK_RECHECK_DAYS * DAY + (AD_LINK_SOFT_GRACE_HOURS - 1) * 3_600_000);
    expect(await down.recheckDue(inGrace, scope)).toEqual({ checked: 1, stopped: 0 });
    expect((await prisma.adCampaign.findUniqueOrThrow({ where: { id: campaign.id } })).status).toBe('LIVE');
    const past = new Date(lastPassed.getTime() + AD_LINK_RECHECK_DAYS * DAY + AD_LINK_SOFT_GRACE_HOURS * 3_600_000);
    expect(await down.recheckDue(past, scope)).toEqual({ checked: 1, stopped: 1 });
    expect((await prisma.adCampaign.findUniqueOrThrow({ where: { id: campaign.id } })).status).toBe('PAUSED');
  });

  it('a soft failure after the grace is what stops it; a hard one never waits', async () => {
    const h = host('hard');
    await allow(h);
    const { campaign } = await live({ value: `https://${h}/a`, host: h, checkedDaysAgo: AD_LINK_RECHECK_DAYS });
    expect(await links({ ...page, status: 404 }).recheckDue(new Date(), { campaignIds: [campaign.id], houseAdIds: [] })).toEqual({ checked: 1, stopped: 1 });
  });

  it('a house ad whose link fails is taken down and the operators are told', async () => {
    const h = host('housecheck');
    await allow(h);
    const p = await placement();
    const house = await prisma.houseAd.create({ data: { tenantId, placementId: p.id, kind: 'IMAGE', fileUrl: 'https://cdn.example/h.png', destinationType: 'URL', destinationValue: `https://${h}/a`, destinationHost: h, destinationApprovedAt: new Date(), destinationCheckedAt: new Date(Date.now() - dayAfterDue * DAY) } });
    houseAdIds.push(house.id);
    expect(await links({ ...page, status: 410 }).recheckDue(new Date(), { campaignIds: [], houseAdIds: [house.id] })).toEqual({ checked: 1, stopped: 1 });
    expect((await prisma.houseAd.findUniqueOrThrow({ where: { id: house.id } })).active).toBe(false);
    expect(await prisma.adsAuditLog.count({ where: { entityId: house.id, action: 'HOUSE_AD_LINK_OFF' } })).toBe(1);
  });

  it('a slow website cannot hold the tick: past the budget the rest waits for the next one, oldest first', async () => {
    const h = host('budget');
    await allow(h);
    const first = await live({ value: `https://${h}/a`, host: h, checkedDaysAgo: dayAfterDue + 2 });
    const second = await live({ value: `https://${h}/b`, host: h, checkedDaysAgo: dayAfterDue });
    const clock = vi.spyOn(Date, 'now');
    const t0 = 1_800_000_000_000;
    clock.mockReturnValue(t0);
    const s = new AdLinkService(prisma, io);
    s.hop = vi.fn(async () => { clock.mockReturnValue(t0 + AD_LINK_TICK_BUDGET_MS); return page; });
    const res = await s.recheckDue(new Date(), { campaignIds: [first.campaign.id, second.campaign.id], houseAdIds: [] });
    clock.mockRestore();
    expect(res).toEqual({ checked: 1, stopped: 0 });
    expect(s.hop).toHaveBeenCalledTimes(1);
    expect(s.hop).toHaveBeenCalledWith(`https://${h}/a`);
  });

  it('the cron fetches nothing while ads are off', async () => {
    vi.stubEnv('ADS_ENABLED', '');
    const spy = vi.spyOn(AdLinkService.prototype, 'recheckDue');
    expect(await new AdsCronService(prisma, io).recheckLinks()).toEqual({ checked: 0, stopped: 0 });
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
    vi.stubEnv('ADS_ENABLED', '1');
  });
});

describe('the way back after a link pause', () => {
  // The route builds its own service, so the network seam for this describe is the service's one walk.
  const spyOnWalk = () => vi.spyOn(AdLinkService.prototype as unknown as { walk: () => Promise<unknown> }, 'walk');
  const resume = (id: string, token: string) => app.inject({ method: 'POST', url: `/api/v1/ads/campaigns/${id}/resume`, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, payload: {} });

  it('the advertiser resumes only on a passing check, through the real route, and it runs again', async () => {
    const h = host('back');
    await allow(h);
    const { campaign, owner } = await live({ value: `https://${h}/a`, host: h });
    await prisma.adCampaign.update({ where: { id: campaign.id }, data: { status: 'PAUSED', statusReason: `${LINK_PAUSE_PREFIX}the page no longer exists` } });
    const walk = spyOnWalk();
    walk.mockResolvedValueOnce({ ok: false, hard: true, reason: 'PAGE_GONE' });
    const still = await resume(campaign.id, owner.token);
    expect(still.statusCode).toBe(409);
    expect(still.json().error.code).toBe('AD_LINK_CHECK_FAILED');
    expect((await prisma.adCampaign.findUniqueOrThrow({ where: { id: campaign.id } })).status).toBe('PAUSED');
    walk.mockResolvedValueOnce({ ok: true, hops: 0 });
    const back = await resume(campaign.id, owner.token);
    expect(back.statusCode, back.body).toBe(200);
    walk.mockRestore();
    const row = await prisma.adCampaign.findUniqueOrThrow({ where: { id: campaign.id } });
    expect([row.status, row.statusReason]).toEqual(['LIVE', null]);
  });

  it('the lifecycle itself refuses a resume with no check behind it', async () => {
    const h = host('nocheck');
    await allow(h);
    const { campaign, owner } = await live({ value: `https://${h}/a`, host: h });
    await prisma.adCampaign.update({ where: { id: campaign.id }, data: { status: 'PAUSED', statusReason: `${LINK_PAUSE_PREFIX}the page no longer exists` } });
    const { AdsLifecycleService } = await import('../modules/ads/lifecycle.service');
    await expect(new AdsLifecycleService(prisma, io).transition(campaign.id, 'resume', owner.userId, undefined, { byAdvertiser: true })).rejects.toMatchObject({ code: 'CAMPAIGN_PAUSED_FOR_LINK' });
  });

  it('an ordinary pause resumes as before, with no check', async () => {
    const h = host('plain');
    await allow(h);
    const { campaign, owner } = await live({ value: `https://${h}/a`, host: h });
    await prisma.adCampaign.update({ where: { id: campaign.id }, data: { status: 'PAUSED', statusReason: null } });
    const walk = spyOnWalk();
    expect((await resume(campaign.id, owner.token)).statusCode).toBe(200);
    expect(walk).not.toHaveBeenCalled();
    walk.mockRestore();
  });
});

// The services above run on a plain client. The routes run on the tenant-scoped clients, which is where an
// upsert on a compound key or a nested read would break, so each write path goes through its real route once.
describe('through the real routes, on the tenant-scoped clients', () => {
  const json = (token: string, reason = false) => ({ authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(reason ? { 'x-swift-reason': TEST_ADMIN_REASON } : {}) });

  it('paying on the route queues the new website, once', async () => {
    const h = host('routepay');
    const owner = await user(['CUSTOMER']);
    const a = await advertiser(owner.userId);
    const p = await placement();
    const week2 = new Date(week().getTime() + 14 * DAY);
    const c = await prisma.adCampaign.create({ data: { tenantId, advertiserId: a.id, placementId: p.id, name: 'Route', cities: ['*'], startWeek: week2, endWeek: week2, destinationType: 'URL', destinationValue: `https://${h}/a`, destinationHost: h } });
    campaignIds.push(c.id);
    const res = await app.inject({ method: 'POST', url: `/api/v1/ads/campaigns/${c.id}/checkout`, headers: json(owner.token), payload: {} });
    expect(res.statusCode, res.body).toBe(200);
    keepFixtures(owner.userId, a.id, p.id, c.id);
    expect(await prisma.adLinkDomain.count({ where: { tenantId, host: h, status: 'PENDING' } })).toBe(1);
  });

  it('the review queue reaches the reviewer with its link, and the ad approves, on the admin routes', async () => {
    const admin = await user(['ADMIN']);
    const { creative, campaign } = await atReview({ type: 'DEEPLINK', value: 'swift://store/route-store' });
    const queue = await app.inject({ method: 'GET', url: '/api/v1/admin/ads/creatives/queue', headers: json(admin.token) });
    expect(queue.statusCode, queue.body).toBe(200);
    const row = (queue.json().data as Array<{ id: string; link: { kind: string; value: string } }>).find((r) => r.id === creative.id);
    expect(row?.link).toMatchObject({ kind: 'INSIDE_SWIFT', value: 'swift://store/route-store' });
    const approved = await app.inject({ method: 'PUT', url: `/api/v1/admin/ads/creatives/${creative.id}/approve`, headers: json(admin.token), payload: {} });
    expect(approved.statusCode, approved.body).toBe(200);
    const after = await prisma.adCampaign.findUniqueOrThrow({ where: { id: campaign.id } });
    expect([after.status, after.destinationApprovedByUserId]).toEqual(['SCHEDULED', admin.userId]);
  });

  it('refusing a website on the admin route stops the campaign on it', async () => {
    const admin = await user(['ADMIN']);
    const h = host('routerefuse');
    const domain = await allow(h);
    const { campaign } = await live({ value: `https://${h}/a`, host: h });
    const res = await app.inject({ method: 'PUT', url: `/api/v1/admin/ads/link-domains/${domain.id}/reject`, headers: json(admin.token, true), payload: { reason: 'This website now sells a banned item' } });
    expect(res.statusCode, res.body).toBe(200);
    expect((await prisma.adLinkDomain.findUniqueOrThrow({ where: { id: domain.id } })).status).toBe('REJECTED');
    expect((await prisma.adCampaign.findUniqueOrThrow({ where: { id: campaign.id } })).status).toBe('PAUSED');
  });

  it('an operator of one tenant never sees the other tenant\'s websites', async () => {
    const admin = await user(['ADMIN']);
    const h = host('othertenant');
    const row = await prisma.adLinkDomain.create({ data: { tenantId: 'link-other-tenant', host: h } });
    const list = await app.inject({ method: 'GET', url: '/api/v1/admin/ads/link-domains', headers: json(admin.token) });
    expect((list.json().data as Array<{ id: string }>).map((d) => d.id)).not.toContain(row.id);
  });
});

describe('before money moves', () => {
  it('paying for an ad on a new website queues one PENDING row for a person', async () => {
    const h = host('firstpay');
    const owner = await user(['CUSTOMER']);
    const a = await advertiser(owner.userId);
    const p = await placement();
    const c = await prisma.adCampaign.create({ data: { tenantId, advertiserId: a.id, placementId: p.id, name: 'Pay', cities: ['*'], startWeek: new Date(week().getTime() + 14 * DAY), endWeek: new Date(week().getTime() + 14 * DAY), destinationType: 'URL', destinationValue: `https://${h}/a`, destinationHost: h } });
    campaignIds.push(c.id);
    await new AdCheckoutService(prisma, io).checkout(c.id, 'MANUAL');
    keepFixtures(owner.userId, a.id, p.id, c.id);
    const domains = await prisma.adLinkDomain.findMany({ where: { tenantId, host: h } });
    expect(domains.map((d) => [d.status, d.reviewedByUserId, d.reviewedAt])).toEqual([['PENDING', null, null]]);
  });

  it('a campaign on a website a person refused cannot check out', async () => {
    const h = host('nomoney');
    await allow(h, 'REJECTED');
    const owner = await user(['CUSTOMER']);
    const a = await advertiser(owner.userId);
    const p = await placement();
    const c = await prisma.adCampaign.create({ data: { tenantId, advertiserId: a.id, placementId: p.id, name: 'No money', cities: ['*'], startWeek: new Date(week().getTime() + 14 * DAY), endWeek: new Date(week().getTime() + 14 * DAY), destinationType: 'URL', destinationValue: `https://${h}/a`, destinationHost: h } });
    campaignIds.push(c.id);
    await expect(new AdCheckoutService(prisma, io).checkout(c.id, 'MANUAL')).rejects.toMatchObject({ code: 'AD_LINK_DOMAIN_REFUSED' });
    expect(await prisma.adInvoice.count({ where: { campaignId: c.id } })).toBe(0);
  });
});
