import type { AdCampaign, AdLinkDomain, AdLinkDomainStatus, PrismaClient } from '@prisma/client';
import type { Server } from 'socket.io';
import { AppError, NotFoundError } from '../../utils/errors';
import { log } from '../../utils/logger';
import { NotificationService, notifyAdmins } from '../notification/notification.service';
import { AD_LINK_REFUSAL_WORDS, classifyAdLink, LINK_PAUSE_PREFIX, type AdLinkVerdict } from './ad-link-policy';
import { AD_LINK_CHECK_WORDS, checkAdLink, type AdLinkCheck, type AdLinkHop } from './ad-link-probe';
import { SUSPENSION_PAUSE_PREFIX } from './advertiser.service';
import { AdsLifecycleService } from './lifecycle.service';
import { AdServingService } from './serving.service';

// [ADS-ON · 4 Oct ruling, audit MASTER-005] The human side of ad links.
//   - Ads may always link inside Swift. An outside link needs its website on the allow-list: the first ad
//     using a new website leaves a PENDING row, and only a person moves it (who and when on the row).
//   - The ad itself needs its link approved at review: the reviewer sees the link, and approval walks its
//     redirects once. An app store link has no allow-list row: "the advertiser's own app" cannot be read
//     from a URL, so that approval is the human check.
//   - While a campaign can run, the link is re-checked weekly. A link that fails pauses the campaign with
//     a notice to the advertiser (or takes a house ad down, with a notice to the operators). A site that
//     merely did not answer is tried again every tick, and pauses after AD_LINK_SOFT_GRACE_HOURS.

export const AD_LINK_RECHECK_DAYS = 7;
export const AD_LINK_SOFT_GRACE_HOURS = 6;
/** One tick walks at most this many links, one at a time, for at most this long: the tick shares a worker
 *  with dispatch, so a slow website never holds it. What is left waits for the next tick, oldest first. */
const RECHECK_BATCH = 20;
export const AD_LINK_TICK_BUDGET_MS = 60_000;
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

type LinkRow = Pick<AdCampaign, 'tenantId' | 'destinationType' | 'destinationValue' | 'destinationApprovedAt'>;
type Outcome = { ok: true } | { ok: false; hard: boolean; words: string };

export interface AdLinkSummary {
  kind: 'NONE' | 'INSIDE_SWIFT' | 'EXTERNAL' | 'APP_STORE' | 'REFUSED';
  value: string | null;
  host: string | null;
  domainId: string | null;
  domainStatus: AdLinkDomainStatus | null;
  refusal: string | null;
}

/** Before money: a link that can never be approved is said now, not after the advertiser paid. Paying is also
 *  what puts a new website in front of a person: only an approved advertiser gets here, so a draft by anyone
 *  else can never fill the review list. */
export async function queueLinkForPayment(prisma: PrismaClient, row: LinkRow): Promise<void> {
  const verdict = classifyAdLink(row.destinationType, row.destinationValue);
  if (!verdict.ok) throw new AppError(400, verdict.reason, AD_LINK_REFUSAL_WORDS[verdict.reason]);
  if (verdict.kind !== 'EXTERNAL') return;
  const domain = await prisma.adLinkDomain.upsert({
    where: { tenantId_host: { tenantId: row.tenantId, host: verdict.host } },
    create: { tenantId: row.tenantId, host: verdict.host },
    update: {},
  });
  if (domain.status === 'REJECTED') throw websiteRefused(409);
}

function websiteRefused(status: number): AppError {
  return new AppError(status, 'AD_LINK_DOMAIN_REFUSED', 'Swift cannot link ads to that website. Use a different link, or contact support.');
}

export class AdLinkService {
  private lifecycle: AdsLifecycleService;
  private notifications: NotificationService;
  /** Test seam: one request of the redirect walk. */
  hop?: (url: string) => Promise<AdLinkHop>;

  constructor(private prisma: PrismaClient, private io: Server) {
    this.lifecycle = new AdsLifecycleService(prisma, io);
    this.notifications = new NotificationService(prisma, io);
  }

  private refused(verdict: Extract<AdLinkVerdict, { ok: false }>): AppError {
    return new AppError(400, verdict.reason, AD_LINK_REFUSAL_WORDS[verdict.reason]);
  }

  private walk(value: string, host: string): Promise<AdLinkCheck> {
    return checkAdLink(value, host, this.hop ? { hop: this.hop } : {});
  }

  /** The first sight of a website: a PENDING row for a person. A row that exists is never changed here. */
  private async domainFor(tenantId: string, host: string): Promise<AdLinkDomain> {
    return this.prisma.adLinkDomain.upsert({ where: { tenantId_host: { tenantId, host } }, create: { tenantId, host }, update: {} });
  }

  /** An advertiser names a link on a draft: its shape is judged now, and a website a person refused stops here.
   *  A new website is not queued yet: see queueLinkForPayment. */
  async admit(tenantId: string, type: 'NONE' | 'URL' | 'DEEPLINK', value: string | null | undefined) {
    const verdict = classifyAdLink(type, value);
    if (!verdict.ok) throw this.refused(verdict);
    if (verdict.kind === 'NONE') return { destinationType: 'NONE' as const, destinationValue: null, destinationHost: null };
    if (verdict.kind === 'EXTERNAL') {
      const domain = await this.prisma.adLinkDomain.findUnique({ where: { tenantId_host: { tenantId, host: verdict.host } } });
      if (domain?.status === 'REJECTED') throw websiteRefused(400);
    }
    return { destinationType: type, destinationValue: verdict.value, destinationHost: 'host' in verdict ? verdict.host : null };
  }

  /** One link, now: allow-list, then the redirect walk. No writes. */
  private async evaluate(row: LinkRow): Promise<Outcome> {
    const verdict = classifyAdLink(row.destinationType, row.destinationValue);
    if (!verdict.ok) return { ok: false, hard: true, words: 'the link is not allowed' };
    if (verdict.kind === 'NONE' || verdict.kind === 'INSIDE_SWIFT') return { ok: true };
    if (verdict.kind === 'EXTERNAL') {
      const domain = await this.prisma.adLinkDomain.findUnique({ where: { tenantId_host: { tenantId: row.tenantId, host: verdict.host } } });
      if (domain?.status !== 'APPROVED') return { ok: false, hard: true, words: 'the website is not on the approved list' };
    }
    const check = await this.walk(verdict.value, verdict.host);
    return check.ok ? { ok: true } : { ok: false, hard: check.hard, words: AD_LINK_CHECK_WORDS[check.reason] };
  }

  /** What the review screen shows. Reads only. */
  async summaries(rows: LinkRow[]): Promise<AdLinkSummary[]> {
    const verdicts = rows.map((r) => classifyAdLink(r.destinationType, r.destinationValue));
    const hosts = [...new Set(verdicts.flatMap((v) => (v.ok && v.kind === 'EXTERNAL' ? [v.host] : [])))];
    const domains = hosts.length ? await this.prisma.adLinkDomain.findMany({ where: { host: { in: hosts } } }) : [];
    return verdicts.map((v, i) => {
      if (!v.ok) return { kind: 'REFUSED', value: rows[i]?.destinationValue ?? null, host: null, domainId: null, domainStatus: null, refusal: AD_LINK_REFUSAL_WORDS[v.reason] };
      if (v.kind === 'NONE') return { kind: 'NONE', value: null, host: null, domainId: null, domainStatus: null, refusal: null };
      if (v.kind === 'INSIDE_SWIFT') return { kind: 'INSIDE_SWIFT', value: v.value, host: null, domainId: null, domainStatus: null, refusal: null };
      const domain = v.kind === 'EXTERNAL' ? domains.find((d) => d.tenantId === rows[i]?.tenantId && d.host === v.host) : undefined;
      return { kind: v.kind, value: v.value, host: v.host, domainId: domain?.id ?? null, domainStatus: domain?.status ?? null, refusal: null };
    });
  }

  /** The reviewer approves an ad: the link must pass first. Returns what to stamp, in the approval's own
   *  transaction, or null when there is nothing to stamp. Walks the redirects, so it runs before that transaction. */
  async reviewLink(row: LinkRow): Promise<{ destinationHost: string | null } | null> {
    const verdict = classifyAdLink(row.destinationType, row.destinationValue);
    if (!verdict.ok) throw new AppError(409, verdict.reason, AD_LINK_REFUSAL_WORDS[verdict.reason]);
    if (verdict.kind === 'NONE') return null;
    if (verdict.kind === 'INSIDE_SWIFT') return row.destinationApprovedAt ? null : { destinationHost: null };
    if (verdict.kind === 'EXTERNAL') {
      const domain = await this.domainFor(row.tenantId, verdict.host);
      if (domain.status !== 'APPROVED') throw new AppError(409, 'AD_LINK_DOMAIN_NOT_APPROVED', `The website ${verdict.host} is not on the approved list. Approve it first, or reject this ad.`);
    }
    if (row.destinationApprovedAt) return null;
    const check = await this.walk(verdict.value, verdict.host);
    if (!check.ok) throw new AppError(409, 'AD_LINK_CHECK_FAILED', `This ad's link cannot run: ${AD_LINK_CHECK_WORDS[check.reason]}.`);
    return { destinationHost: verdict.host };
  }

  /** A house ad's link: the operator saving it is its human approval, but it meets the same rules. */
  async houseLink(tenantId: string, type: 'NONE' | 'URL' | 'DEEPLINK', value: string | null | undefined, adminUserId: string) {
    const admitted = await this.admit(tenantId, type, value);
    const none = { destinationApprovedByUserId: null, destinationApprovedAt: null, destinationCheckedAt: null };
    if (admitted.destinationType === 'NONE') return { ...admitted, ...none };
    const now = new Date();
    const stamped = { destinationApprovedByUserId: adminUserId, destinationApprovedAt: now, destinationCheckedAt: now };
    const stamp = await this.reviewLink({ tenantId, destinationType: admitted.destinationType, destinationValue: admitted.destinationValue, destinationApprovedAt: null });
    return { ...admitted, destinationHost: stamp?.destinationHost ?? null, ...stamped };
  }

  // ── The allow-list ─────────────────────────────────────────────────────────

  /** Who approved a website, by name: the point of the record is that a person can be asked. */
  async listDomains(tenantId: string, status?: AdLinkDomainStatus) {
    const rows = await this.prisma.adLinkDomain.findMany({
      where: { tenantId, ...(status ? { status } : {}) },
      orderBy: [{ status: 'asc' }, { createdAt: 'asc' }],
      take: 200,
    });
    const ids = [...new Set(rows.flatMap((r) => (r.reviewedByUserId ? [r.reviewedByUserId] : [])))];
    const people = ids.length ? await this.prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, firstName: true, lastName: true } }) : [];
    const nameOf = new Map(people.map((p) => [p.id, `${p.firstName} ${p.lastName}`.trim()]));
    return rows.map((r) => ({ ...r, reviewedByName: r.reviewedByUserId ? nameOf.get(r.reviewedByUserId) ?? null : null }));
  }

  private async decide(id: string, adminUserId: string, status: 'APPROVED' | 'REJECTED', action: string, reason?: string): Promise<AdLinkDomain> {
    const domain = await this.prisma.adLinkDomain.findUnique({ where: { id } });
    if (!domain) throw new NotFoundError('AdLinkDomain', id);
    if (domain.status === status) throw new AppError(409, 'ALREADY_REVIEWED', `This website is already ${status.toLowerCase()}.`);
    return this.prisma.$transaction(async (tx) => {
      const moved = await tx.adLinkDomain.updateMany({
        where: { id, status: domain.status },
        data: { status, reviewNotes: reason ?? null, reviewedByUserId: adminUserId, reviewedAt: new Date() },
      });
      if (moved.count !== 1) throw new AppError(409, 'ALREADY_REVIEWED', 'This website was reviewed just now.');
      await tx.adsAuditLog.create({
        data: {
          tenantId: domain.tenantId, actorUserId: adminUserId, action, entityType: 'AdLinkDomain', entityId: id,
          before: { status: domain.status } as never, after: { status } as never, reason: reason ?? domain.host,
        },
      });
      return tx.adLinkDomain.findUniqueOrThrow({ where: { id } });
    });
  }

  async approveDomain(id: string, adminUserId: string): Promise<AdLinkDomain> {
    return this.decide(id, adminUserId, 'APPROVED', 'LINK_DOMAIN_APPROVE');
  }

  /** Refuse a website. One that was approved leaves the list at once: nothing on it serves from this moment,
   *  and every campaign and house ad linking to it stops, with its notice. */
  async rejectDomain(id: string, adminUserId: string, reason: string): Promise<AdLinkDomain> {
    const domain = await this.decide(id, adminUserId, 'REJECTED', 'LINK_DOMAIN_REJECT', reason);
    AdServingService.invalidateTenant(domain.tenantId);
    const words = 'Swift no longer allows ads to link to that website';
    // A campaign its advertiser paused is told too, or it would resume into nothing. A pause that is already the
    // link check's, or a suspension's, stands: reinstating a suspension brings it back, and the serve gate holds it.
    const campaigns = await this.prisma.adCampaign.findMany({
      where: {
        tenantId: domain.tenantId, destinationHost: domain.host,
        OR: [
          { status: { in: ['SCHEDULED', 'LIVE'] } },
          { status: 'PAUSED', OR: [{ statusReason: null }, { NOT: { OR: [{ statusReason: { startsWith: LINK_PAUSE_PREFIX } }, { statusReason: { startsWith: SUSPENSION_PAUSE_PREFIX } }] } }] },
        ],
      },
      select: { id: true },
    });
    for (const c of campaigns) await this.pause(c.id, words);
    const houseAds = await this.prisma.houseAd.findMany({ where: { tenantId: domain.tenantId, destinationHost: domain.host, active: true }, select: { id: true } });
    for (const h of houseAds) await this.houseAdOff(h.id, domain.tenantId, words);
    return domain;
  }

  // ── The weekly re-check ────────────────────────────────────────────────────

  private async pause(campaignId: string, words: string): Promise<boolean> {
    try {
      const paused = await this.lifecycle.transition(campaignId, 'link_check_failed', 'system:ads-link-check', `${LINK_PAUSE_PREFIX}${words}`);
      AdServingService.invalidateTenant(paused.tenantId);
      return true;
    } catch (err) {
      log().error({ err, campaignId }, 'ads link check could not pause a campaign — continuing');
      return false;
    }
  }

  private async houseAdOff(id: string, tenantId: string, words: string): Promise<void> {
    await this.prisma.houseAd.update({ where: { id }, data: { active: false } });
    await this.prisma.adsAuditLog.create({
      data: { tenantId, actorUserId: 'system:ads-link-check', action: 'HOUSE_AD_LINK_OFF', entityType: 'HouseAd', entityId: id, reason: words },
    });
    AdServingService.invalidateTenant(tenantId);
    await notifyAdmins(this.prisma, this.notifications, {
      tenantId,
      title: 'A house ad was taken down',
      body: `A house ad stopped running: ${words}.`,
      data: { kind: 'ad_house_link_off', houseAdId: id },
    }).catch(() => {});
  }

  /** Whether a failure on this row stops it now: a hard one always, a site that did not answer once it has
   *  been failing past the grace on top of the week. */
  private stopsNow(outcome: Extract<Outcome, { ok: false }>, lastPassed: Date | null, now: Date): boolean {
    if (outcome.hard || lastPassed === null) return true;
    return now.getTime() - lastPassed.getTime() >= AD_LINK_RECHECK_DAYS * DAY_MS + AD_LINK_SOFT_GRACE_HOURS * HOUR_MS;
  }

  /** The links whose week is up, oldest first, in every tenant. `scope` narrows it for tests. */
  async recheckDue(now = new Date(), scope: { campaignIds?: string[]; houseAdIds?: string[] } = {}): Promise<{ checked: number; stopped: number }> {
    const cutoff = new Date(now.getTime() - AD_LINK_RECHECK_DAYS * DAY_MS);
    const due = { destinationType: { not: 'NONE' as const }, OR: [{ destinationCheckedAt: null }, { destinationCheckedAt: { lte: cutoff } }] };
    const campaigns = await this.prisma.adCampaign.findMany({
      where: { ...due, status: { in: ['SCHEDULED', 'LIVE'] }, ...(scope.campaignIds ? { id: { in: scope.campaignIds } } : {}) },
      orderBy: { destinationCheckedAt: { sort: 'asc', nulls: 'first' } },
      take: RECHECK_BATCH,
    });
    const houseAds = await this.prisma.houseAd.findMany({
      where: { ...due, active: true, ...(scope.houseAdIds ? { id: { in: scope.houseAdIds } } : {}) },
      orderBy: { destinationCheckedAt: { sort: 'asc', nulls: 'first' } },
      take: RECHECK_BATCH,
    });
    const stopAt = Date.now() + AD_LINK_TICK_BUDGET_MS;
    let stopped = 0;
    let checked = 0;
    for (const c of campaigns) {
      if (Date.now() >= stopAt) break;
      checked += 1;
      const outcome = await this.evaluate(c);
      if (outcome.ok) await this.prisma.adCampaign.update({ where: { id: c.id }, data: { destinationCheckedAt: now } });
      else if (this.stopsNow(outcome, c.destinationCheckedAt, now) && await this.pause(c.id, outcome.words)) stopped += 1;
    }
    for (const h of houseAds) {
      if (Date.now() >= stopAt) break;
      checked += 1;
      const outcome = await this.evaluate(h);
      if (outcome.ok) await this.prisma.houseAd.update({ where: { id: h.id }, data: { destinationCheckedAt: now } });
      else if (this.stopsNow(outcome, h.destinationCheckedAt, now)) { await this.houseAdOff(h.id, h.tenantId, outcome.words); stopped += 1; }
    }
    return { checked, stopped };
  }

  /** The advertiser fixed the page and resumes: a campaign the link check paused goes back only on a passing
   *  check. Returns whether this was such a pause. */
  async recheckForResume(campaignId: string): Promise<boolean> {
    const c = await this.prisma.adCampaign.findUnique({ where: { id: campaignId } });
    if (!c?.statusReason?.startsWith(LINK_PAUSE_PREFIX)) return false;
    const outcome = await this.evaluate(c);
    if (!outcome.ok) throw new AppError(409, 'AD_LINK_CHECK_FAILED', `This campaign's link still cannot run: ${outcome.words}.`);
    await this.prisma.adCampaign.update({ where: { id: campaignId }, data: { destinationCheckedAt: new Date() } });
    return true;
  }
}
