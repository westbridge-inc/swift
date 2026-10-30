import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Fastify, { type FastifyInstance, type HTTPMethods, type InjectOptions } from 'fastify';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { registerErrorHandler } from '../middleware/error-handler';
import { registerEmptyJsonBodyParser } from '../plugins/empty-json';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { authRoutes } from '../modules/auth/auth.routes';
import { customerRoutes } from '../modules/user/customer.routes';
import { vendorRoutes } from '../modules/vendor/vendor.routes';
import { riderRoutes } from '../modules/rider/rider.routes';
import { driverRoutes } from '../modules/driver/driver.routes';
import { adminRoutes } from '../modules/admin/admin.routes';
import { searchRoutes } from '../modules/search/search.routes';
import { chatRoutes } from '../modules/chat/chat.routes';
import { verificationRoutes } from '../modules/verification/verification.routes';
import { ridesRoutes } from '../modules/rides/rides.routes';
import { safetyRoutes } from '../modules/safety/safety.routes';
import { adsRoutes } from '../modules/ads/ads.routes';
import { placesRoutes } from '../modules/places/places.routes';
import courierRoutes from '../modules/courier/courier.routes';
import { servicesRoutes } from '../modules/services/services.routes';
import { serviceCatalogRoutes } from '../modules/services/service-catalog.routes';
import { moderationRoutes } from '../modules/moderation/moderation.routes';
import { partnerRoutes } from '../modules/partner/partner.routes';
import { statementRoutes } from '../modules/order/statement.routes';
import { callsRoutes } from '../modules/calls/calls.routes';
import { providerFeeRoutes } from '../modules/services/provider-fee.routes';
import { loginWithOtp } from './helpers/otp';

// ---------------------------------------------------------------------------
// Authz matrix — the "single consistent security model" control.
//
// Walks the LIVE route table (collected via onRoute, so a new route is in the
// matrix the moment it ships) and fires every role-prefixed route with (a) no
// token and (b) a WRONG role's token. The only acceptable answers are 401/403.
// A 2xx is a missing gate; a 400/404/5xx means body parsing or lookups ran
// before authorization — an information oracle either way.
// ---------------------------------------------------------------------------

let app: FastifyInstance;
const routeTable: Array<{ method: string; url: string }> = [];

/** Wrong-role bearer tokens per protected prefix. */
const tokens: Record<string, string> = {};

async function buildTestApp() {
  const server = Fastify({ logger: false });
  registerErrorHandler(server);
  registerEmptyJsonBodyParser(server);
  server.addHook('onRoute', (route) => {
    const methods = (Array.isArray(route.method) ? route.method : [route.method]) as HTTPMethods[];
    for (const m of methods) {
      if (m === 'HEAD' || m === 'OPTIONS') continue;
      routeTable.push({ method: m, url: route.url });
    }
  });
  await server.register(prismaPlugin);
  await server.register(redisPlugin);
  await server.register(authPlugin);
  await server.register(socketPlugin);
  await server.register(authRoutes, { prefix: '/api/v1/auth' });
  await server.register(customerRoutes, { prefix: '/api/v1/customer' });
  await server.register(vendorRoutes, { prefix: '/api/v1/vendor' });
  await server.register(riderRoutes, { prefix: '/api/v1/rider' });
  await server.register(driverRoutes, { prefix: '/api/v1/driver' });
  await server.register(adminRoutes, { prefix: '/api/v1/admin' });
  // SWIFT-AUD-D3-02: every authenticated prefix is enrolled, mirroring
  // server.ts registration exactly — a prefix missing here is a prefix whose
  // future missing gate this control cannot catch.
  await server.register(searchRoutes, { prefix: '/api/v1' });
  await server.register(chatRoutes, { prefix: '/api/v1/chat' });
  await server.register(moderationRoutes, { prefix: '/api/v1' });
  await server.register(verificationRoutes, { prefix: '/api/v1/verification' });
  await server.register(ridesRoutes, { prefix: '/api/v1/rides' });
  await server.register(safetyRoutes, { prefix: '/api/v1/safety' });
  await server.register(adsRoutes, { prefix: '/api/v1/ads' });
  await server.register(placesRoutes, { prefix: '/api/v1/places' });
  await server.register(courierRoutes, { prefix: '/api/v1/courier' });
  await server.register(servicesRoutes, { prefix: '/api/v1/services' });
  await server.register(serviceCatalogRoutes, { prefix: '/api/v1/services' });
  await server.register(partnerRoutes, { prefix: '/api/v1/partner' });
  await server.register(statementRoutes, { prefix: '/api/v1/statements' });
  await server.register(callsRoutes, { prefix: '/api/v1/calls' });
  await server.register(providerFeeRoutes, { prefix: '/api/v1/provider' });
  await server.ready();
  return server;
}

// [AUD-L7-008] This suite runs the app in development mode; the worker must
// get its own mode back afterwards. Registered first, so it runs LAST (after
// the teardown below unstubs).
const NODE_ENV_AT_LOAD = process.env['NODE_ENV'];
afterAll(() => { expect(process.env['NODE_ENV']).toBe(NODE_ENV_AT_LOAD); });

beforeAll(async () => {
  vi.stubEnv('ADS_ENABLED', '1');
  vi.stubEnv('NODE_ENV', 'development'); // restored by vi.unstubAllEnvs() in afterAll
  process.env['DATABASE_URL'] = process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift';
  process.env['REDIS_URL'] = process.env['REDIS_URL'] || 'redis://localhost:6382';
  app = await buildTestApp();

  const customer = await loginWithOtp(app, '+5926003000'); // CUSTOMER
  const vendor = await loginWithOtp(app, '+5926002000'); // VENDOR_OWNER
  const mover = await loginWithOtp(app, '+5926004000'); // MOVER (rider)
  tokens['customer'] = customer.json().data.tokens.accessToken;
  tokens['vendor'] = vendor.json().data.tokens.accessToken;
  tokens['mover'] = mover.json().data.tokens.accessToken;
});

afterAll(async () => {
  vi.unstubAllEnvs();
  await app.close();
});

/** Fill path params with a syntactically-plausible id that matches nothing.
 *  Authorization must fire BEFORE any lookup, so "does not exist" never gets
 *  the chance to answer. */
function materialize(url: string): string {
  return url.replace(/:[a-zA-Z]+/g, 'cmq00000000000000000000000');
}

function fire(method: string, url: string, token?: string) {
  const opts: InjectOptions = {
    method: method as InjectOptions['method'],
    url: materialize(url),
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
  };
  if (method !== 'GET' && method !== 'DELETE') opts.payload = {};
  return app.inject(opts);
}

/** The gate must answer before anything else does. */
const REJECTED = [401, 403];

interface PrefixSpec {
  prefix: string;
  /** roles whose tokens must be rejected on every route under the prefix */
  wrongRoles: string[];
}

const MATRIX: PrefixSpec[] = [
  // [T1 · row 300] Mounted before but never swept. Any signed-in person may act
  // as a customer (a vendor owner orders food) and any may be an advertiser, so
  // both are multi-role: the unauthenticated sweep applies to every route.
  { prefix: '/api/v1/customer/', wrongRoles: [] },
  { prefix: '/api/v1/ads/', wrongRoles: [] },
  // moderationRoutes (app.ts, prefix /api/v1): reporting and blocking, any signed-in person.
  { prefix: '/api/v1/reports', wrongRoles: [] },
  { prefix: '/api/v1/blocks', wrongRoles: [] },
  { prefix: '/api/v1/vendor/', wrongRoles: ['customer', 'mover'] },
  { prefix: '/api/v1/rider/', wrongRoles: ['customer', 'vendor'] },
  { prefix: '/api/v1/driver/', wrongRoles: ['customer', 'vendor'] },
  { prefix: '/api/v1/admin/', wrongRoles: ['customer', 'vendor', 'mover'] },
  // SWIFT-AUD-D3-02 — the remaining authenticated surface. wrongRoles is
  // empty where the prefix is multi-role by design (any authenticated user
  // may act as a customer — a vendor owner orders food; chat spans both
  // parties of an order; partner/become upgrades a customer). The
  // unauthenticated sweep still applies to every route.
  { prefix: '/api/v1/search/', wrongRoles: [] },
  { prefix: '/api/v1/chat/', wrongRoles: [] },
  // [O-1] The call bridge: any party to an order (customer, mover, store) may ask Swift to connect a call.
  { prefix: '/api/v1/calls/', wrongRoles: [] },
  { prefix: '/api/v1/verification/', wrongRoles: [] },
  { prefix: '/api/v1/rides/', wrongRoles: [] },
  // SOS is raiseable by any authenticated actor (passenger/driver/rider), so
  // multi-role by design; the ops-only ack/resolve are handler-gated + covered
  // by safety-sos-core.test.ts. The unauthenticated sweep still hits every route.
  { prefix: '/api/v1/safety/', wrongRoles: [] },
  { prefix: '/api/v1/places/', wrongRoles: [] },
  { prefix: '/api/v1/courier/', wrongRoles: [] },
  { prefix: '/api/v1/services/', wrongRoles: [] },
  { prefix: '/api/v1/partner/', wrongRoles: [] },
  { prefix: '/api/v1/statements/', wrongRoles: [] },
  // [BILL-PRO PR4] A pro's own weekly fee. Being a pro is a profile, not a role (a customer, a store owner or a mover
  // may also be a service provider), so no role token is wrong here by role; the gate is the person's OWN provider
  // profile (no profile: refused, see PRO_FEE_NON_PRO below). The unauthenticated sweep applies to every route.
  { prefix: '/api/v1/provider/', wrongRoles: [] },
];

/** Routes that are UNAUTHENTICATED on purpose: a server-minted HMAC signature
 *  (issued only to the authenticated owner) IS the authorization — the
 *  document/statement render-token model. Anything added here needs the same
 *  written justification. */
const PUBLIC_BY_DESIGN = new Set([
  // Guest catalogue reads use the public browse tenant/visibility authority.
  // The sync operation stays in the authenticated sweep below.
  'GET /api/v1/search',
  'GET /api/v1/search/suggestions',
  'GET /api/v1/search/trending',
  'GET /api/v1/search/nearby',
  // Service-provider browse is customer discovery (guest-browse doctrine):
  // optionalAuth by design; unauthenticated requests hit schema validation
  // (400 on missing query), never a data leak — the handler serves a public
  // trade listing projection.
  'GET /api/v1/services/providers',
  'GET /api/v1/statements/render',
  'GET /api/v1/verification/render/:docId',
  // Recipient tracking link SMS'd to package receivers (who have no account):
  // the unguessable courierTrackingToken IS the authorization; the handler
  // selects a narrow, phone-free projection.
  'GET /api/v1/courier/track/:token',
  // Ad serving + event ingestion are public by design (ads spec §11.1/§12.2):
  // the consumer home screen serves ads to anonymous users; server derives
  // userHash only when signed in, and events are gated by the HMAC impression
  // token (a token never issued by a real serve is unforgeable), not by session.
  'GET /api/v1/ads/serve',
  'POST /api/v1/ads/events',
  // Trip Share public page (safety spec §6): the recipient has NO app and no
  // account — the 128-bit CSPRNG token IS the credential; it grants only the
  // narrow public payload and dies at trip end + grace (or revocation).
  'GET /api/v1/safety/public/trip/:token',
  // [WEB-TAXI] Trip Guardian's texted answer link: a passenger no push reached
  // answers the waiting check-in without signing in — the one-time secret of
  // ONE ask IS the credential; it answers only that check, misses are one 404.
  'POST /api/v1/safety/public/checkin',
  // [T1] Guest browse (customer.routes.ts PUBLIC_BROWSE, the same four URLs):
  // optional auth by design, the public catalogue a guest may look around.
  'GET /api/v1/customer/home',
  'GET /api/v1/customer/vendors',
  'GET /api/v1/customer/vendors/:id',
  'GET /api/v1/customer/vendors/:id/reviews',
  // [T1] The global service taxonomy (service-catalog.routes.ts): identical for
  // every caller, no provider or account data.
  'GET /api/v1/services/catalog',
]);

/** [T1 · row 300] Ops-only routes INSIDE multi-role prefixes. Their prefix sweep
 *  above runs no wrong-role check (any signed-in person may raise an SOS), so
 *  each of these is gated only in its handler. Every one must refuse a
 *  customer, a store owner and a mover before any lookup or body parsing. */
const OPS_ONLY_IN_MULTI_ROLE = [
  'GET /api/v1/safety/ops-alerts',
  'POST /api/v1/safety/ops-alerts/:id/ack',
  'POST /api/v1/safety/ops-alerts/drill',
  'GET /api/v1/safety/sos',
  'POST /api/v1/safety/sos/:id/ack',
  'POST /api/v1/safety/sos/:id/resolve',
  'POST /api/v1/safety/incidents/ops',
  'POST /api/v1/safety/incidents/:id/merge',
  'GET /api/v1/safety/incidents',
  'POST /api/v1/safety/incidents/:id/ack',
  'POST /api/v1/safety/incidents/:id/investigate',
  'POST /api/v1/safety/incidents/:id/close',
  'POST /api/v1/safety/incidents/:id/escalate-police',
  'POST /api/v1/safety/incidents/:id/lift-interim',
  'POST /api/v1/safety/incidents/:id/shadow-restrict',
  'POST /api/v1/safety/incidents/:id/decide',
  'GET /api/v1/safety/evidence',
  'POST /api/v1/safety/evidence/:id/view',
  'POST /api/v1/safety/evidence/:id/seal',
  'POST /api/v1/safety/evidence/:id/legal-hold',
  'POST /api/v1/safety/evidence/:id/export',
  'GET /api/v1/safety/guardian',
] as const;

describe('authz matrix — every role-prefixed route rejects outsiders', () => {
  it('collected a non-trivial route table', () => {
    expect(routeTable.length).toBeGreaterThan(50);
  });

  for (const spec of MATRIX) {
    describe(spec.prefix + '*', () => {
      it('rejects unauthenticated requests on every route', async () => {
        const prefixRoutes = routeTable.filter((r) => r.url.startsWith(spec.prefix));
        expect(prefixRoutes.length).toBeGreaterThan(0);
        const routes = prefixRoutes.filter((r) => !PUBLIC_BY_DESIGN.has(`${r.method} ${r.url}`));
        const offenders: string[] = [];
        for (const r of routes) {
          const res = await fire(r.method, r.url);
          if (!REJECTED.includes(res.statusCode)) {
            offenders.push(`${r.method} ${r.url} -> ${res.statusCode}`);
          }
        }
        expect(offenders, offenders.join('\n')).toEqual([]);
      });

      for (const role of spec.wrongRoles) {
        it(`rejects a ${role} token on every route`, async () => {
          const routes = routeTable.filter(
          (r) => r.url.startsWith(spec.prefix) && !PUBLIC_BY_DESIGN.has(`${r.method} ${r.url}`)
        );
          const offenders: string[] = [];
          for (const r of routes) {
            const res = await fire(r.method, r.url, tokens[role]);
            if (!REJECTED.includes(res.statusCode)) {
              offenders.push(`${r.method} ${r.url} -> ${res.statusCode}`);
            }
          }
          expect(offenders, offenders.join('\n')).toEqual([]);
        });
      }
    });
  }
});

describe('[T1] ops-only routes inside multi-role prefixes refuse every non-ops role', () => {
  it('every declared ops-only route exists (the list cannot go stale)', () => {
    const live = new Set(routeTable.map((r) => `${r.method} ${r.url}`));
    expect(OPS_ONLY_IN_MULTI_ROLE.filter((route) => !live.has(route))).toEqual([]);
  });

  for (const role of ['customer', 'vendor', 'mover']) {
    it(`a ${role} token is refused on every ops-only route`, async () => {
      const offenders: string[] = [];
      for (const route of OPS_ONLY_IN_MULTI_ROLE) {
        const [method, url] = route.split(' ') as [string, string];
        const res = await fire(method, url, tokens[role]);
        if (!REJECTED.includes(res.statusCode)) offenders.push(`${route} -> ${res.statusCode}`);
      }
      expect(offenders, offenders.join('\n')).toEqual([]);
    });
  }
});

// [BILL-PRO PR4] /api/v1/provider reads and pays only the caller's OWN pro fee. The seeded customer, store owner and
// mover have no provider profile, so every route here must refuse them: never a 2xx (no fee read, started or
// paid), never a 5xx. GET /subscription says so with a 404 (no provider profile), as provider-fee-routes.test.ts pins.
describe('[BILL-PRO] /api/v1/provider: a person with no provider profile never reads or pays a pro fee', () => {
  for (const role of ['customer', 'vendor', 'mover']) {
    it(`a ${role} token (no provider profile) is refused on every /api/v1/provider route`, async () => {
      const routes = routeTable.filter((r) => r.url.startsWith('/api/v1/provider/'));
      expect(routes.map((r) => `${r.method} ${r.url}`)).toEqual(expect.arrayContaining([
        'GET /api/v1/provider/subscription', 'POST /api/v1/provider/weekly-fee-ack', 'PUT /api/v1/provider/subscription/billing-method',
        'POST /api/v1/provider/subscription/mmg-checkout',
      ]));
      const offenders: string[] = [];
      for (const r of routes) {
        const res = await fire(r.method, r.url, tokens[role]);
        if (res.statusCode < 400 || res.statusCode >= 500) offenders.push(`${r.method} ${r.url} -> ${res.statusCode}`);
      }
      expect(offenders, offenders.join('\n')).toEqual([]);
      const own = await fire('GET', '/api/v1/provider/subscription', tokens[role]);
      expect([own.statusCode, own.json().error?.code]).toEqual([404, 'NOT_FOUND']);
    });
  }
});

describe('Suspended accounts are cut off immediately', () => {
  it('a suspended user cannot use a live access token and cannot refresh', async () => {
    // Self-contained: create a fresh ACTIVE customer + a live session directly.
    const rnd = `${Date.now()}${Math.floor(Math.random() * 1e6)}`;
    const user = await app.prisma.user.create({
      data: { phone: `+59269${rnd.slice(-7)}`, firstName: 'Susp', lastName: 'Test', roles: ['CUSTOMER'], activeRole: 'CUSTOMER', isPhoneVerified: true, selfieCapturedAt: new Date(), customer: { create: {} } },
    });
    const userId = user.id;
    const accessToken = app.jwt.sign({ userId, role: 'CUSTOMER', jti: rnd.slice(0, 8) });
    const refreshToken = `rt-${rnd}`;
    await app.prisma.session.create({ data: { authMethod: 'OTP', userId, token: accessToken, refreshToken, deviceId: 'susp', deviceType: 'test', expiresAt: new Date(Date.now() + 86400000) } });

    // Works while ACTIVE.
    const ok = await app.inject({ method: 'GET', url: '/api/v1/customer/profile', headers: { authorization: `Bearer ${accessToken}` } });
    expect(ok.statusCode).toBe(200);

    // Admin suspends the account (status only — sessions are NOT deleted; the
    // cut-off must hold via the authenticate + refresh status checks).
    await app.prisma.user.update({ where: { id: userId }, data: { status: 'SUSPENDED' } });

    // The same still-valid token is now rejected on the very next request.
    const cut = await app.inject({ method: 'GET', url: '/api/v1/customer/profile', headers: { authorization: `Bearer ${accessToken}` } });
    expect(cut.statusCode).toBe(401);

    // And the refresh token cannot mint a fresh access token.
    const refreshed = await app.inject({ method: 'POST', url: '/api/v1/auth/refresh', payload: { refreshToken }, headers: { 'content-type': 'application/json' } });
    expect(refreshed.statusCode).toBe(403);

    await app.prisma.session.deleteMany({ where: { userId } });
    await app.prisma.customer.deleteMany({ where: { userId } });
    await app.prisma.user.deleteMany({ where: { id: userId } });
  });
});

// ---------------------------------------------------------------------------
// SWIFT-092 → [T1 · row 300] composition-root ↔ matrix drift guard, by PLUGIN.
// buildTestApp() must mirror app.ts's route registration. The old guard
// compared URL prefixes, so a second plugin under a prefix the matrix already
// sweeps passed unseen (moderationRoutes under /api/v1, serviceCatalogRoutes
// under /api/v1/services). It now compares route plugins by name and prefix:
// a plugin app.ts mounts and this suite neither mounts at the same prefix nor
// exempts (unauthenticated by design, with the reason written below) fails.
// ---------------------------------------------------------------------------

/** "plugin@prefix" for every route plugin a source registers, with or without a prefix. */
function routePluginMounts(source: string): string[] {
  const mounts = new Set<string>();
  for (const m of source.matchAll(/\.register\(\s*([A-Za-z_$][\w$]*)\s*(?:,\s*\{\s*prefix:\s*'([^']*)'\s*\})?\s*\)/g)) {
    if (m[1]!.endsWith('Routes')) mounts.add(`${m[1]}@${m[2] ?? ''}`);
  }
  return [...mounts].sort();
}

/** Route plugins the composition root mounts that the matrix neither mounts (same plugin, same
 *  prefix) nor exempts by name. Pure, so the guard itself is unit-testable. */
function unmountedRoutePlugins(appMounts: string[], testMounts: string[], exempt: Set<string>): string[] {
  const mounted = new Set(testMounts);
  return appMounts.filter((mount) => !mounted.has(mount) && !exempt.has(mount.split('@')[0]!));
}

describe('composition root ↔ matrix drift guard, by plugin [SWIFT-092 · T1]', () => {
  // Unauthenticated by design — outside the authz matrix on purpose.
  // agentCashRoutes (/billing/mmg) is machine-to-machine (MMG's biller network calls it):
  // HMAC-over-raw-body auth, 503 dark until configured — proven in
  // agent-cash-channels.test.ts (401 only for signatures, per SO-6).
  // attributionRoutes is pre-auth by nature (web install taps + the app's first
  // launch, before any session exists): per-IP rate-limited, server-derived
  // everything, single-candidate-or-Home — proven in qr-attribution.test.ts.
  // discoveryRoutes is the guest-facing category rail (flag-gated read-only
  // aggregates — no user data; browsing needs no session by design).
  // marketRoutes is the same posture one step further in [MKT G1]: the catalogue a
  // shopper browses BEFORE they have an account. It is read-only, carries no user
  // data, and every row it can return is already public — the query goes through
  // VISIBLE_VENDOR_REL and `isAvailable`.
  // mmgCheckoutPublicRoutes is MMG's reply path [mmg checkout 3/6]: the web return
  // page and MMG's own servers post an encrypted reply token there; it only prompts
  // the server's own MMG lookup and answers one of four states — proven in
  // mmg-checkout-routes.test.ts.
  // cardRailPublicRoutes is the card provider's return path [PT-2]: written down as
  // evidence, prompts only the server's own question to the provider — proven in
  // card-rail-routes.test.ts.
  // publicRoutes / qrPublicRoutes (/api/v1/public) and qrResolverRoutes (the printed
  // QR short links) are public pages by name: QR resolution and public profile reads.
  // legalRoutes (/legal) serves the published legal pages.
  // smsInboundRoutes (/api/v1/sms) is the SMS provider calling with a texted reply [R22]:
  // machine-to-machine, HMAC-signed by the provider and refused (403) unsigned, 503 dark
  // until configured; it only ever withdraws marketing consent — proven in marketing-stop.test.ts.
  // callVoiceRoutes (/api/v1/calls/voice) is the voice provider calling back during a Swift-bridged
  // call [O-1]: machine-to-machine, signed by the provider over the exact URL and refused (403)
  // unsigned, 503 until configured; a call back to Swift's number only hears 'call from the app' —
  // proven in call-bridge.test.ts.
  // testControlRoutes exists only in isolated load builds; production never registers it.
  const EXEMPT_PLUGINS = new Set([
    'agentCashRoutes', 'attributionRoutes', 'discoveryRoutes', 'marketRoutes', 'mmgCheckoutPublicRoutes',
    'cardRailPublicRoutes', 'publicRoutes', 'qrPublicRoutes', 'qrResolverRoutes', 'legalRoutes', 'testControlRoutes',
    'smsInboundRoutes', 'callVoiceRoutes',
  ]);

  it('flags a route plugin the matrix never mounts, even under a prefix it already sweeps (red-first)', () => {
    // The old prefix guard passed this: /api/v1 was "mounted" by searchRoutes.
    const missing = unmountedRoutePlugins(
      ['customerRoutes@/api/v1/customer', 'searchRoutes@/api/v1', 'moderationRoutes@/api/v1', 'loyaltyRoutes@/api/v1/loyalty'],
      ['customerRoutes@/api/v1/customer', 'searchRoutes@/api/v1'],
      new Set(),
    );
    expect(missing).toEqual(['moderationRoutes@/api/v1', 'loyaltyRoutes@/api/v1/loyalty']);
    // The same plugin mounted at another prefix is not the same mount.
    expect(unmountedRoutePlugins(['chatRoutes@/api/v1/chat'], ['chatRoutes@/api/v1/messages'], new Set())).toEqual(['chatRoutes@/api/v1/chat']);
  });

  it('every route plugin the composition root (app.ts) registers is mounted here at the same prefix (or exempt)', () => {
    const appMounts = routePluginMounts(readFileSync(resolve(process.cwd(), 'src/app.ts'), 'utf8'));
    const testMounts = routePluginMounts(readFileSync(resolve(process.cwd(), 'src/__tests__/authz-matrix.test.ts'), 'utf8'));
    // Sanity: the parse actually found the registrations (guards against a regex/path break).
    expect(appMounts.length).toBeGreaterThan(25);
    expect(testMounts).toEqual(expect.arrayContaining(['adminRoutes@/api/v1/admin', 'safetyRoutes@/api/v1/safety']));
    // Every exemption still names a plugin app.ts mounts (an exemption cannot outlive its plugin).
    const appPlugins = new Set(appMounts.map((mount) => mount.split('@')[0]));
    expect([...EXEMPT_PLUGINS].filter((name) => !appPlugins.has(name))).toEqual([]);
    expect(unmountedRoutePlugins(appMounts, testMounts, EXEMPT_PLUGINS)).toEqual([]);
  });
});
