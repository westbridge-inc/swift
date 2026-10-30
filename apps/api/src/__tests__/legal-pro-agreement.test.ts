import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import type { UserRole } from '@prisma/client';
import { prismaPlugin, runWithoutTenant } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { authRoutes } from '../modules/auth/auth.routes';
import { registerErrorHandler } from '../middleware/error-handler';
import { LEGAL_VERSION, TERMS, VENDOR_AGREEMENT } from '../modules/legal/legal.routes';
import { MATERIAL_CHANGES, PRO_AGREEMENT_VERSION, acceptanceStatus, materialVersion } from '../modules/legal/reaccept';
import { providerChecklist } from '../modules/services/services.service';
import { testPhone } from './helpers/fixture-ids';

// ---------------------------------------------------------------------------
// [BILL-PRO · owner 28 Oct 2026 Rounds A+B · COORD 29 Oct 16:13Z · DRAFT until counsel] The Business Agreement covers
// an independent service provider ("Provider", a pro in the Services tab): section 12 (documents a person checks,
// the weekly services fee paid only on MMG's checkout page in the app or on the website, never charged before
// acceptance, the trial, one fee with a Services store, the unpaid-fee block) and the provider's side of Terms s.5:
// publishing a list of services with bookable times is their advance acceptance of bookings made from it.
// MATERIAL for Providers only: a pro is asked for a fresh tick and nobody else is; and the server books nobody from
// a pro's list until that pro accepted a version with this clause. Synthetic data only.
// ---------------------------------------------------------------------------

/** The provider-only summary (read when a case runs, so a missing entry fails that case, not the file). */
const proSummary = (): readonly string[] => MATERIAL_CHANGES.find((c) => c.version === PRO_AGREEMENT_VERSION)?.summary ?? ['<no provider summary>'];
const flat = (html: string) => html.replace(/<\/?b>/g, '').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ');

describe('the Business Agreement covers Providers (section 12)', () => {
  const text = flat(VENDOR_AGREEMENT);
  const s12 = text.slice(text.indexOf('12. Independent service providers'));

  it('names the Provider in the opening, and how a Provider accepts it (when the app asks, after the profile is created)', () => {
    expect(text).toContain('including an independent professional who offers their own services in the Services tab ("Provider", see section 12)');
    // [REVIEW-F #2225 S3-1] No box exists when a provider profile is created: a Provider accepts when the app asks.
    expect(text).toContain('when you create your store, or when the app asks you to accept this Agreement (as it asks a Provider after they create their provider profile)');
    expect(text).not.toContain('your provider profile, or when');
    expect(text).toContain('or, as a Provider, for yourself.');
  });

  it("states the owner's fee rulings: MMG checkout in the app or on the website, never before acceptance, trial, one fee, the 48-hour block", () => {
    expect(s12.length).toBeGreaterThan(500);
    expect(s12).toContain('only through MMG\'s checkout page in the Swift app or on the Swift website');
    expect(s12).toContain('Nothing is charged until you have accepted this Agreement and confirmed in the app that you understand the weekly fee');
    expect(s12).toContain('once the weekly fee has started for Providers, you are not listed and cannot take new requests or bookings');
    // [REVIEW-F #2225 S3-2 · owner 30 Oct 00:14Z] The trial starts on the LATER of switch-on and the pro's own steps.
    expect(s12).toContain('Your free trial, where offered, starts on the day the last of these happens: the weekly fee starts for Providers, Swift approves your documents, you accept this Agreement, and you confirm in the app that you understand the weekly fee.');
    expect(s12).not.toContain('starts the day you accept it');
    // [REVIEW-F S4-1] A live store fee covers the pro, unpaid or not: one fee, and its 48-hour rule.
    expect(s12).toContain('your store\'s weekly fee covers your provider profile: you pay one fee, and the 48-hour rule below applies to it');
    expect(s12).toContain('unpaid 48 hours after it falls due, you are not listed and cannot receive new requests, send quotes or confirm new bookings');
    expect(s12).toContain('jobs already booked can still go ahead, and your chats stay open');
    expect(s12).toContain('A person at Swift checks them.');
  });

  it("is the provider's side of Terms s.5: a published list of services with bookable times is their advance acceptance", () => {
    expect(s12).toContain('If you publish a list of services with bookable times, you accept in advance every booking a customer makes from it at a time the app shows as free');
    // The customer-facing half (#2210) names the same list.
    expect(flat(TERMS)).toContain('list of services with bookable times');
  });
});

describe('the fresh tick is asked of Providers, and nobody else', () => {
  const CUSTOMER = ['CUSTOMER'] as UserRole[];

  it('is a material version for Providers only, served now; the version everyone else answers to is unchanged', () => {
    expect(LEGAL_VERSION).toBe('2026-10-29.2');
    expect(PRO_AGREEMENT_VERSION).toBe(LEGAL_VERSION);
    expect(MATERIAL_CHANGES.find((c) => c.version === PRO_AGREEMENT_VERSION)).toMatchObject({ audience: 'provider' });
    expect(materialVersion(LEGAL_VERSION)).toBe('2026-10-28.1');
    expect(proSummary().join(' ')).toMatch(/list of services with bookable times/);
  });

  it('a customer or a store owner at 2026-10-29 is not asked; a pro who never accepted the agreement is, with the provider summary', () => {
    expect(acceptanceStatus({ tosVersion: '2026-10-29', roles: CUSTOMER }).needsAcceptance).toBe(false);
    expect(acceptanceStatus({ tosVersion: '2026-10-29', roles: ['VENDOR_OWNER', 'CUSTOMER'] as UserRole[] }).needsAcceptance).toBe(false);
    expect(acceptanceStatus({ tosVersion: '2026-10-29', roles: CUSTOMER, pro: { acceptedVersion: null } }))
      .toMatchObject({ needsAcceptance: true, summary: [...proSummary()], agreements: ['vendor_agreement'] });
    // Already at the served version as a customer (signed up today): still asked, for the agreement.
    expect(acceptanceStatus({ tosVersion: LEGAL_VERSION, roles: CUSTOMER, pro: { acceptedVersion: null } }).needsAcceptance).toBe(true);
  });

  it('a pro who accepted it is not asked; one who accepted an older Business Agreement (a store owner) is', () => {
    expect(acceptanceStatus({ tosVersion: LEGAL_VERSION, roles: CUSTOMER, pro: { acceptedVersion: PRO_AGREEMENT_VERSION } }))
      .toMatchObject({ needsAcceptance: false, summary: [] });
    expect(acceptanceStatus({ tosVersion: '2026-10-29', roles: ['VENDOR_OWNER', 'CUSTOMER'] as UserRole[], pro: { acceptedVersion: '2026-10-28' } }))
      .toMatchObject({ needsAcceptance: true, summary: [...proSummary()], agreements: ['vendor_agreement'] });
  });

  it('a pro behind on the Terms too sees every summary they missed, oldest first, the provider lines last', () => {
    const v281 = MATERIAL_CHANGES.find((c) => c.version === '2026-10-28.1')!.summary;
    expect(acceptanceStatus({ tosVersion: '2026-10-28', roles: CUSTOMER, pro: { acceptedVersion: null } }).summary).toEqual([...v281, ...proSummary()]);
  });

  it('before the provider version is served, nobody is asked for it', () => {
    expect(acceptanceStatus({ tosVersion: '2026-10-29', roles: CUSTOMER, pro: { acceptedVersion: null } }, '2026-10-29'))
      .toMatchObject({ needsAcceptance: false, summary: [] });
  });
});

let app: FastifyInstance;
const userIds: string[] = [];
const providerIds: string[] = [];

async function mkPro(tosVersion: string | null, opts: { verified?: boolean } = {}) {
  return runWithoutTenant(async () => {
    const u = await app.prisma.user.create({
      data: { phone: testPhone(), firstName: 'Pro', lastName: `Agree${nanoid(5)}`, roles: ['CUSTOMER'], activeRole: 'CUSTOMER', isPhoneVerified: true, tosVersion, selfieCapturedAt: new Date() },
    });
    userIds.push(u.id);
    const token = app.jwt.sign({ userId: u.id, role: 'CUSTOMER', jti: nanoid(8) });
    await app.prisma.session.create({ data: { authMethod: 'OTP', userId: u.id, token, refreshToken: nanoid(48), deviceId: 'pro-agree', deviceType: 'test', expiresAt: new Date(Date.now() + 86_400_000) } });
    const provider = await app.prisma.serviceProvider.create({ data: { userId: u.id, trade: 'tutor', isVerified: !!opts.verified } });
    providerIds.push(provider.id);
    if (opts.verified) {
      for (const docType of await providerChecklist(app.prisma, u.id)) {
        await app.prisma.verificationDocument.create({
          data: { userId: u.id, role: 'CUSTOMER', docType, fileUrl: `storage://t/${docType}.jpg`, status: 'APPROVED', consentAt: new Date(), privacyNoticeVersion: 'v1' },
        });
      }
    }
    return { id: u.id, token };
  }, 'test-setup:pro-agreement');
}
const call = (method: 'GET' | 'POST', token: string, payload?: Record<string, unknown>) =>
  app.inject({ method, url: '/api/v1/auth/legal-acceptance', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, ...(payload ? { payload } : {}) });
const rows = (userId: string) => runWithoutTenant(() => app.prisma.consentRecord.findMany({
  where: { subjectId: userId }, orderBy: { documentType: 'asc' }, select: { documentType: true, documentVersion: true, action: true, subjectType: true },
}), 'test-read:pro-agreement');

beforeAll(async () => {
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  await app.register(authRoutes, { prefix: '/api/v1/auth' });
  await app.ready();
});

afterAll(async () => {
  await runWithoutTenant(async () => {
    await app.prisma.verificationDocument.deleteMany({ where: { userId: { in: userIds } } });
    await app.prisma.serviceProvider.deleteMany({ where: { id: { in: providerIds } } });
    await app.prisma.session.deleteMany({ where: { userId: { in: userIds } } });
    await app.prisma.user.deleteMany({ where: { id: { in: userIds } } }).catch(() => {});
  }, 'test-cleanup:pro-agreement');
  await app.close();
});

describe('GET/POST /auth/legal-acceptance for a pro', () => {
  it('a pro already at the served version (signed up as a customer today) is asked; the tick records only the Business Agreement, once', async () => {
    const pro = await mkPro(LEGAL_VERSION);
    const status = await call('GET', pro.token);
    expect(status.statusCode, status.body).toBe(200);
    expect(status.json().data).toMatchObject({ currentVersion: LEGAL_VERSION, acceptedVersion: LEGAL_VERSION, needsAcceptance: true, summary: [...proSummary()], agreements: ['vendor_agreement'] });

    expect((await call('POST', pro.token, { version: LEGAL_VERSION, accept: true })).statusCode).toBe(200);
    expect((await rows(pro.id)).map((r) => [r.documentType, r.documentVersion, r.action, r.subjectType])).toEqual([
      ['vendor_agreement', LEGAL_VERSION, 'granted', 'vendor_user'],
    ]);
    expect((await call('GET', pro.token)).json().data).toMatchObject({ needsAcceptance: false, summary: [] });
    // A double tap records once.
    expect((await call('POST', pro.token, { version: LEGAL_VERSION, accept: true })).statusCode).toBe(200);
    expect(await rows(pro.id)).toHaveLength(1);
  });

  it('[REVIEW-G #2225 S4-2] a pro who withdrew the agreement is asked again (never stuck: unbookable and never asked)', async () => {
    const pro = await mkPro(LEGAL_VERSION);
    expect((await call('POST', pro.token, { version: LEGAL_VERSION, accept: true })).statusCode).toBe(200);
    expect((await call('GET', pro.token)).json().data).toMatchObject({ needsAcceptance: false });
    await new Promise((r) => setTimeout(r, 5)); // capturedAt orders the rows
    await runWithoutTenant(() => app.prisma.consentRecord.create({
      data: { subjectType: 'vendor_user', subjectId: pro.id, documentType: 'vendor_agreement', documentVersion: LEGAL_VERSION, documentContentHash: 'withdrawal', action: 'withdrawn', surface: 'ios' },
    }), 'test-setup:pro-agreement');
    expect((await call('GET', pro.token)).json().data).toMatchObject({ needsAcceptance: true, agreements: ['vendor_agreement'] });
  });

  it('a pro behind on the Terms accepts the Terms, the Privacy Policy and the Business Agreement together', async () => {
    const pro = await mkPro('2026-10-29');
    expect((await call('POST', pro.token, { version: LEGAL_VERSION, accept: true })).statusCode).toBe(200);
    expect((await rows(pro.id)).map((r) => [r.documentType, r.documentVersion, r.action])).toEqual([
      ['privacy_policy', LEGAL_VERSION, 're_granted'],
      ['terms_of_service', LEGAL_VERSION, 're_granted'],
      ['vendor_agreement', LEGAL_VERSION, 'granted'],
    ]);
  });
});
