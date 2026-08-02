import { describe, it, expect, beforeAll, afterAll } from 'vitest';
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
import { partnerRoutes } from '../modules/partner/partner.routes';
import { aiRoutes } from '../modules/ai/ai.routes';
import { statementRoutes } from '../modules/order/statement.routes';
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
  await server.register(verificationRoutes, { prefix: '/api/v1/verification' });
  await server.register(ridesRoutes, { prefix: '/api/v1/rides' });
  await server.register(safetyRoutes, { prefix: '/api/v1/safety' });
  await server.register(adsRoutes, { prefix: '/api/v1/ads' });
  await server.register(placesRoutes, { prefix: '/api/v1/places' });
  await server.register(courierRoutes, { prefix: '/api/v1/courier' });
  await server.register(servicesRoutes, { prefix: '/api/v1/services' });
  await server.register(partnerRoutes, { prefix: '/api/v1/partner' });
  await server.register(aiRoutes, { prefix: '/api/v1/ai' });
  await server.register(statementRoutes, { prefix: '/api/v1/statements' });
  await server.ready();
  return server;
}

beforeAll(async () => {
  process.env['NODE_ENV'] = 'development';
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
  { prefix: '/api/v1/ai/', wrongRoles: [] },
  { prefix: '/api/v1/statements/', wrongRoles: [] },
];

/** Routes that are UNAUTHENTICATED on purpose: a server-minted HMAC signature
 *  (issued only to the authenticated owner) IS the authorization — the
 *  document/statement render-token model. Anything added here needs the same
 *  written justification. */
const PUBLIC_BY_DESIGN = new Set([
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
]);

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
    await app.prisma.session.create({ data: { userId, token: accessToken, refreshToken, deviceId: 'susp', deviceType: 'test', expiresAt: new Date(Date.now() + 86400000) } });

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
// SWIFT-092 — server↔matrix prefix drift guard. buildTestApp() must mirror
// server.ts's route registration: any /api/v1 prefix server.ts mounts but this
// suite never enrolls is a prefix whose future missing authz gate this control
// cannot catch. Fail the build the moment a new prefix is added to server.ts
// without either enrolling it in buildTestApp() or exempting it (unauthenticated
// by design). This is the drift guard the AUD-D3-02 comment above assumes.
// ---------------------------------------------------------------------------

/** /api/v1 prefixes registered in server.ts that are neither mounted in the
 *  test app nor explicitly exempt. Pure, so the guard itself is unit-testable. */
function unmountedApiPrefixes(serverPrefixes: string[], mountedUrls: string[], exempt: Set<string>): string[] {
  return serverPrefixes.filter((p) => {
    if (exempt.has(p)) return false;
    return !mountedUrls.some((u) => u === p || u.startsWith(p + '/'));
  });
}

describe('server↔matrix prefix drift guard [SWIFT-092]', () => {
  // Unauthenticated by design — outside the authz matrix on purpose.
  const EXEMPT = new Set(['/api/v1/public']);

  it('flags a server prefix the matrix never mounts (red-first)', () => {
    // Pretend server.ts added /api/v1/loyalty but buildTestApp never enrolled it.
    const missing = unmountedApiPrefixes(
      ['/api/v1/customer', '/api/v1/loyalty'],
      ['/api/v1/customer/profile', '/api/v1/customer/orders'],
      EXEMPT,
    );
    expect(missing).toEqual(['/api/v1/loyalty']);
  });

  it('every /api/v1 prefix server.ts registers is enrolled here (or exempt)', () => {
    const serverSrc = readFileSync(resolve(process.cwd(), 'src/server.ts'), 'utf8');
    const serverPrefixes = [...new Set([...serverSrc.matchAll(/prefix:\s*'(\/api\/v1[^']*)'/g)].map((m) => m[1]!))];
    // Sanity: the parse actually found the registrations (guards against a regex/path break).
    expect(serverPrefixes.length).toBeGreaterThan(10);

    const mountedUrls = routeTable.map((r) => r.url);
    const missing = unmountedApiPrefixes(serverPrefixes, mountedUrls, EXEMPT);
    if (missing.length) {
      throw new Error(
        `server.ts registers /api/v1 prefixes with no authz-matrix enrollment: ${missing.join(', ')}. ` +
          `Enroll them in buildTestApp() so their gates are tested, or add to EXEMPT if unauthenticated by design.`,
      );
    }
    expect(missing).toEqual([]);
  });
});
